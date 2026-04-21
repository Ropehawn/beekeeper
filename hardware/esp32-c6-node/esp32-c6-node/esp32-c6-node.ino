// BeeKeeper ESP32-C6 Node — wireless ambient + weight + acoustic sensor
//
// Reads:
//   - BME280 over I2C (Qwiic at 0x77, falls back to 0x76)
//   - HX711 load-cell ADC over 2-wire (DT/CLK GPIOs)
//   - INMP441 MEMS mic over I2S (BCLK/WS/SD GPIOs)
//
// Broadcasts a single 22-byte Manufacturer Specific Data BLE advertisement
// every ADV_INTERVAL_MS that the tachyon-hub BLE scanner decodes.
//
// Target board:  ESP32-C6 (native USB-Serial/JTAG)
// Framework:     arduino-esp32 (ESP-IDF v5.1+)
//
// ── Serial commands (over /dev/ttyACM0 at 115200) ───────────────────────────
//   tare            — zero the HX711 against current load (stored in NVS)
//   cal <grams>     — calibrate: tell the node known reference weight in grams
//                     with that load on the scale. Stores scale factor in NVS.
//   reset           — clear tare + calibration
//   status          — print current readings + calibration state
//
// ── BLE advertisement layout (20 bytes Manufacturer Specific Data) ──────────
//   See README.md for the canonical wire format.

#include <Wire.h>
#include <Adafruit_Sensor.h>
#include <Adafruit_BME280.h>
#include <HX711.h>
#include <Preferences.h>
#include <math.h>

#include <NimBLEDevice.h>

#include <driver/i2s_std.h>

#include <arduinoFFT.h>

// ── Config ──────────────────────────────────────────────────────────────────
static const uint16_t COMPANY_ID     = 0xFFFF;  // R&D / no-company
static const uint8_t  SIG_BYTE_0     = 'B';
static const uint8_t  SIG_BYTE_1     = 'K';
static const uint8_t  PROTO_VERSION  = 0x04;    // v4 adds 4 FFT bands
static const uint8_t  NODE_TYPE_FULL = 0x03;    // BME280 + HX711 + INMP441

static const uint32_t ADV_INTERVAL_MS = 2000;
static const char*    DEVICE_NAME     = "BK-C6";  // short to leave room in adv

// SparkFun Qwiic uses default Wire pins; override here if needed.
static const int I2C_SDA_PIN = -1;
static const int I2C_SCL_PIN = -1;

// HX711 wiring — IO18/IO19 pads on the SparkFun ESP32-C6 Qwiic Pocket.
// These GPIOs are broken out on the edge header, have no special function,
// and don't conflict with the Qwiic I²C bus (which uses GPIO 6/7).
// Using GPIO 6 here previously corrupted the Qwiic bus at boot because the
// HX711 lib drives SCK as an output, shorting SDA.
static const int HX711_DT_PIN  = 18;
static const int HX711_SCK_PIN = 19;

// HX711 sample rate (channel A gain 128, 10 SPS typical)
static const uint8_t HX711_GAIN = 128;

// INMP441 I2S mic wiring — IO2/IO3/IO4 pads on the C6 Pocket.
static const gpio_num_t I2S_BCLK_PIN = GPIO_NUM_2;   // C6 → mic bit clock
static const gpio_num_t I2S_WS_PIN   = GPIO_NUM_3;   // C6 → mic word select
static const gpio_num_t I2S_SD_PIN   = GPIO_NUM_4;   // mic → C6 data

// Audio capture config
static const uint32_t AUDIO_SAMPLE_RATE_HZ = 16000;  // good for bee acoustics
static const size_t   AUDIO_WINDOW_SAMPLES = 512;    // 32 ms @ 16 kHz

// FFT bands tuned for beehive acoustics.
// Bin resolution = 16000 / 512 = 31.25 Hz per bin. Bin k corresponds to
// frequency k × 31.25 Hz.
//   Low       (100–200 Hz):  general fanning/buzz
//   Mid-low   (200–400 Hz):  queen piping fundamental (~400 Hz)
//   Mid-high  (400–800 Hz):  alarm / worker comms
//   High      (800–2000 Hz): transients, swarm chatter
static const int BAND_LOW_START_BIN     = 3;    //  93.75 Hz
static const int BAND_LOW_END_BIN       = 6;    // 187.50 Hz
static const int BAND_MIDLOW_START_BIN  = 7;    // 218.75 Hz
static const int BAND_MIDLOW_END_BIN    = 12;   // 375.00 Hz
static const int BAND_MIDHIGH_START_BIN = 13;   // 406.25 Hz
static const int BAND_MIDHIGH_END_BIN   = 25;   // 781.25 Hz
static const int BAND_HIGH_START_BIN    = 26;   // 812.50 Hz
static const int BAND_HIGH_END_BIN      = 63;   // 1968.75 Hz

// Default HX711 scale factor (counts per gram) before user calibration.
// ~20000 is typical for 4x 50kg half-bridge load cells in a Wheatstone config.
static const float DEFAULT_SCALE_FACTOR = 1.0f;

// ── Globals ─────────────────────────────────────────────────────────────────
Adafruit_BME280 bme;
HX711           scale;
Preferences     prefs;

bool     bmeAvailable  = false;
bool     hxAvailable   = false;
bool     hxCalibrated  = false;
bool     micAvailable  = false;
long     hxTareOffset  = 0;
float    hxScaleFactor = DEFAULT_SCALE_FACTOR;

i2s_chan_handle_t i2sRxHandle = nullptr;

uint8_t  flagsByte    = 0;  // b0=BME, b1=HX711, b2=calibrated, b3=first-boot, b4=mic

NimBLEAdvertising* pAdvertising = nullptr;

// ── Helpers ─────────────────────────────────────────────────────────────────
static bool initBME280() {
  // begin() probes with a read; we also verify sensor ID AND that a fresh
  // forced measurement produces a physically plausible temperature. If the
  // chip ACK'd but calibration read failed silently (known Adafruit lib
  // quirk on power-up races), temperature comes back as ~179C — we retry.
  for (uint8_t attempt = 0; attempt < 3; attempt++) {
    for (uint8_t addr : {0x77, 0x76}) {
      if (!bme.begin(addr, &Wire)) continue;
      if (bme.sensorID() != 0x60) continue;
      bme.setSampling(
        Adafruit_BME280::MODE_FORCED,
        Adafruit_BME280::SAMPLING_X2,
        Adafruit_BME280::SAMPLING_X16,
        Adafruit_BME280::SAMPLING_X1,
        Adafruit_BME280::FILTER_X4,
        Adafruit_BME280::STANDBY_MS_0_5
      );
      bme.takeForcedMeasurement();
      delay(30);
      float t = bme.readTemperature();
      // Plausible reading = calibration coefficients loaded correctly.
      // Garbage (~179C) means coeffs didn't read; retry fresh.
      if (!isnan(t) && t > -40.0f && t < 85.0f) {
        return true;
      }
      // Calibration is bad — reset bus and retry
      Wire.end();
      delay(100);
      if (I2C_SDA_PIN >= 0 && I2C_SCL_PIN >= 0) Wire.begin(I2C_SDA_PIN, I2C_SCL_PIN);
      else                                       Wire.begin();
      Wire.setClock(100000);  // drop to 100 kHz on retry
      delay(50);
    }
  }
  return false;
}

static bool initHX711() {
  scale.begin(HX711_DT_PIN, HX711_SCK_PIN, HX711_GAIN);
  delay(50);
  // HX711 can take 400 ms to start, longer if the bridge is unbalanced.
  // Give it up to 3 s and retry the ready-wait a few times.
  for (uint8_t attempt = 0; attempt < 3; attempt++) {
    if (scale.wait_ready_timeout(3000)) {
      long raw = scale.read_average(2);
      // Raw reads 0 or -1 suggest a floating DT pin (no real HX711).
      // Saturation values (0x7FFFFF, -0x800000) are legitimate — the HX711
      // is alive but its analog inputs are unconnected or bridge-unbalanced.
      // Treat those as "present but needs wiring".
      if (raw != 0 && raw != -1) return true;
    }
    delay(100);
  }
  return false;
}

static void loadCalibration() {
  prefs.begin("bkc6", false);  // read-write namespace
  hxTareOffset  = prefs.getLong("tare", 0);
  hxScaleFactor = prefs.getFloat("scale", DEFAULT_SCALE_FACTOR);
  hxCalibrated  = (hxScaleFactor != DEFAULT_SCALE_FACTOR);
  if (hxCalibrated) {
    scale.set_offset(hxTareOffset);
    scale.set_scale(hxScaleFactor);
    flagsByte |= 0x04;
  }
}

static void saveTare(long offset) {
  hxTareOffset = offset;
  prefs.putLong("tare", offset);
  scale.set_offset(offset);
}

static void saveScale(float factor) {
  hxScaleFactor = factor;
  prefs.putFloat("scale", factor);
  scale.set_scale(factor);
  hxCalibrated = true;
  flagsByte |= 0x04;
}

// ── I²S mic (INMP441) ───────────────────────────────────────────────────────
static bool initI2SMic() {
  i2s_chan_config_t chanCfg = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_0, I2S_ROLE_MASTER);
  if (i2s_new_channel(&chanCfg, NULL, &i2sRxHandle) != ESP_OK) return false;

  i2s_std_config_t stdCfg = {
    .clk_cfg  = I2S_STD_CLK_DEFAULT_CONFIG(AUDIO_SAMPLE_RATE_HZ),
    .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(
                  I2S_DATA_BIT_WIDTH_32BIT, I2S_SLOT_MODE_MONO),
    .gpio_cfg = {
      .mclk = I2S_GPIO_UNUSED,
      .bclk = I2S_BCLK_PIN,
      .ws   = I2S_WS_PIN,
      .dout = I2S_GPIO_UNUSED,
      .din  = I2S_SD_PIN,
      .invert_flags = { false, false, false },
    },
  };
  // INMP441 with L/R pin tied to GND → fills the left slot only.
  stdCfg.slot_cfg.slot_mask = I2S_STD_SLOT_LEFT;

  if (i2s_channel_init_std_mode(i2sRxHandle, &stdCfg) != ESP_OK) {
    i2s_del_channel(i2sRxHandle);
    i2sRxHandle = nullptr;
    return false;
  }
  if (i2s_channel_enable(i2sRxHandle) != ESP_OK) {
    i2s_del_channel(i2sRxHandle);
    i2sRxHandle = nullptr;
    return false;
  }
  return true;
}

// FFT buffers sized to AUDIO_WINDOW_SAMPLES.
// arduinoFFT needs separate real/imaginary arrays. ~4 KB each.
static float fftReal[AUDIO_WINDOW_SAMPLES];
static float fftImag[AUDIO_WINDOW_SAMPLES];
static ArduinoFFT<float> fftEngine(
  fftReal, fftImag, AUDIO_WINDOW_SAMPLES, (float)AUDIO_SAMPLE_RATE_HZ);

// Convert an average per-bin magnitude to a uint8 dBFS magnitude byte.
// fullScaleMag is the single-bin magnitude a full-scale tone at that bin
// would produce (≈ 2^23 × N/2 for a 24-bit PCM input with a Hann window).
static uint8_t magToDbfsByte(float mag, float fullScaleMag) {
  if (mag <= 0.0f) return 127;
  float db = 20.0f * log10f(mag / fullScaleMag);
  int m = (int)(-db + 0.5f);
  if (m < 0) m = 0;
  if (m > 127) m = 127;
  return (uint8_t)m;
}

static float avgBinMagnitude(int startBin, int endBin) {
  float sum = 0.0f;
  int n = endBin - startBin + 1;
  if (n <= 0) return 0.0f;
  for (int k = startBin; k <= endBin; k++) sum += fftReal[k];
  return sum / (float)n;
}

// Reads AUDIO_WINDOW_SAMPLES samples from the mic and returns:
//   *rmsOut  — RMS magnitude in dBFS (0 = full scale, 127 = silent)
//   *peakOut — peak magnitude in dBFS (same encoding)
//   bandOut[0..3] — per-band dBFS magnitudes (same encoding)
// All out-params set to 0xFF if no mic or read failure.
static void readAudioFeatures(uint8_t* rmsOut, uint8_t* peakOut, uint8_t* bandOut /* [4] */) {
  *rmsOut = 0xFF;
  *peakOut = 0xFF;
  for (int i = 0; i < 4; i++) bandOut[i] = 0xFF;
  if (!micAvailable || !i2sRxHandle) return;

  static int32_t buf[AUDIO_WINDOW_SAMPLES];
  size_t bytesRead = 0;
  esp_err_t err = i2s_channel_read(
    i2sRxHandle, buf, sizeof(buf), &bytesRead, pdMS_TO_TICKS(150));
  if (err != ESP_OK || bytesRead < sizeof(buf)) return;

  // INMP441 outputs 24-bit signed data left-justified in the 32-bit slot.
  // Shift right by 8 to recover the 24-bit sample. Also copy into fftReal
  // for the FFT pass (imag = 0).
  int64_t sumSq = 0;
  int32_t peak = 0;
  for (size_t i = 0; i < AUDIO_WINDOW_SAMPLES; i++) {
    int32_t s = buf[i] >> 8;         // 24-bit signed
    sumSq += (int64_t)s * (int64_t)s;
    int32_t abs_s = (s < 0) ? -s : s;
    if (abs_s > peak) peak = abs_s;
    fftReal[i] = (float)s;
    fftImag[i] = 0.0f;
  }

  const float fullScale = 8388608.0f;   // 2^23
  float rms = sqrtf((float)((double)sumSq / (double)AUDIO_WINDOW_SAMPLES));
  float rmsDb  = (rms  > 0.0f) ? 20.0f * log10f(rms  / fullScale) : -127.0f;
  float peakDb = (peak > 0)    ? 20.0f * log10f((float)peak / fullScale) : -127.0f;

  int rmsMag  = (int)(-rmsDb  + 0.5f);
  int peakMag = (int)(-peakDb + 0.5f);
  if (rmsMag  < 0) rmsMag  = 0;  if (rmsMag  > 127) rmsMag  = 127;
  if (peakMag < 0) peakMag = 0;  if (peakMag > 127) peakMag = 127;

  *rmsOut  = (uint8_t)rmsMag;
  *peakOut = (uint8_t)peakMag;

  // FFT pass — window, transform, magnitude.
  fftEngine.windowing(FFTWindow::Hann, FFTDirection::Forward);
  fftEngine.compute(FFTDirection::Forward);
  fftEngine.complexToMagnitude();  // fftReal[k] now holds |X[k]|

  // Reference: a full-scale tone at a single bin produces magnitude
  // ≈ fullScale × N/2 (with Hann correction ~0.5×, so use fullScale × N/4).
  const float fullScaleBin = fullScale * ((float)AUDIO_WINDOW_SAMPLES / 4.0f);

  float lowMag     = avgBinMagnitude(BAND_LOW_START_BIN,     BAND_LOW_END_BIN);
  float midLowMag  = avgBinMagnitude(BAND_MIDLOW_START_BIN,  BAND_MIDLOW_END_BIN);
  float midHighMag = avgBinMagnitude(BAND_MIDHIGH_START_BIN, BAND_MIDHIGH_END_BIN);
  float highMag    = avgBinMagnitude(BAND_HIGH_START_BIN,    BAND_HIGH_END_BIN);

  bandOut[0] = magToDbfsByte(lowMag,     fullScaleBin);
  bandOut[1] = magToDbfsByte(midLowMag,  fullScaleBin);
  bandOut[2] = magToDbfsByte(midHighMag, fullScaleBin);
  bandOut[3] = magToDbfsByte(highMag,    fullScaleBin);
}

static int32_t readWeightGrams() {
  if (!hxAvailable) return 0x7FFFFFFF;  // sentinel "invalid"
  if (!scale.wait_ready_timeout(250)) return 0x7FFFFFFF;
  // Average 3 reads to reduce jitter. get_units() applies offset + scale.
  float grams = hxCalibrated ? scale.get_units(3) : 0.0f;
  // If not calibrated, report raw counts in grams field so hub can back-calibrate
  if (!hxCalibrated) {
    grams = (float)(scale.read_average(3) - hxTareOffset);
  }
  if (isnan(grams) || isinf(grams)) return 0x7FFFFFFF;
  long g = lroundf(grams);
  if (g > 2000000L || g < -2000000L) return 0x7FFFFFFF;  // out of sane range
  return (int32_t)g;
}

static void buildAdvPayload(uint8_t* buf) {
  int16_t  tempX100 = 0x7FFF;
  uint16_t humX100  = 0xFFFF;
  uint32_t pressPa  = 0xFFFFFF;
  int32_t  weightG  = 0x7FFFFFFF;
  uint8_t  battery  = 0xFF;
  uint8_t  audioRms  = 0xFF;
  uint8_t  audioPeak = 0xFF;
  uint8_t  audioBands[4] = { 0xFF, 0xFF, 0xFF, 0xFF };

  if (bmeAvailable) {
    // In MODE_FORCED we must trigger a conversion each cycle. Wait for it
    // to finish (blocks ~10ms with our oversampling settings).
    bme.takeForcedMeasurement();
    float t = bme.readTemperature();
    float h = bme.readHumidity();
    float p = bme.readPressure();

    if (!isnan(t) && t > -100.0f && t < 150.0f) tempX100 = (int16_t)lroundf(t * 100.0f);
    if (!isnan(h) && h >= 0.0f && h <= 100.0f)  humX100  = (uint16_t)lroundf(h * 100.0f);
    if (!isnan(p) && p > 0 && p < 120000.0f)    pressPa  = (uint32_t)lroundf(p);
    flagsByte |= 0x01;
  } else {
    flagsByte &= ~0x01;
  }

  if (hxAvailable) {
    weightG = readWeightGrams();
    flagsByte |= 0x02;
  } else {
    flagsByte &= ~0x02;
  }

  if (micAvailable) {
    readAudioFeatures(&audioRms, &audioPeak, audioBands);
    flagsByte |= 0x10;   // b4 = mic present
  } else {
    flagsByte &= ~0x10;
  }

  buf[0]  = COMPANY_ID & 0xFF;
  buf[1]  = (COMPANY_ID >> 8) & 0xFF;
  buf[2]  = SIG_BYTE_0;
  buf[3]  = SIG_BYTE_1;
  buf[4]  = PROTO_VERSION;
  buf[5]  = NODE_TYPE_FULL;
  buf[6]  = tempX100 & 0xFF;
  buf[7]  = (tempX100 >> 8) & 0xFF;
  buf[8]  = humX100 & 0xFF;
  buf[9]  = (humX100 >> 8) & 0xFF;
  buf[10] = pressPa & 0xFF;
  buf[11] = (pressPa >> 8) & 0xFF;
  buf[12] = (pressPa >> 16) & 0xFF;
  buf[13] = weightG & 0xFF;
  buf[14] = (weightG >> 8) & 0xFF;
  buf[15] = (weightG >> 16) & 0xFF;
  buf[16] = (weightG >> 24) & 0xFF;
  buf[17] = battery;
  buf[18] = flagsByte;
  buf[19] = audioRms;
  buf[20] = audioPeak;
  buf[21] = audioBands[0];   // 100–200 Hz
  buf[22] = audioBands[1];   // 200–400 Hz (queen fundamental)
  buf[23] = audioBands[2];   // 400–800 Hz
  buf[24] = audioBands[3];   // 800–2000 Hz
  buf[25] = 0x00;            // reserved
}

// ── Serial command handler ──────────────────────────────────────────────────
static void handleSerialCommand(const String& line) {
  if (line.length() == 0) return;
  String cmd = line;
  cmd.trim();

  if (cmd == "status") {
    Serial.printf("BME280: %s  HX711: %s  calibrated: %s\n",
                  bmeAvailable ? "yes" : "no",
                  hxAvailable  ? "yes" : "no",
                  hxCalibrated ? "yes" : "no");
    Serial.printf("  tare_offset=%ld  scale_factor=%.4f\n",
                  hxTareOffset, hxScaleFactor);
    if (hxAvailable) {
      long raw = scale.wait_ready_timeout(500) ? scale.read_average(5) : 0;
      Serial.printf("  raw=%ld  weight_g=%ld\n", raw, (long)readWeightGrams());
    }
  } else if (cmd == "tare") {
    if (!hxAvailable) { Serial.println("HX711 not present."); return; }
    Serial.println("Taring... keep scale empty.");
    if (!scale.wait_ready_timeout(2000)) { Serial.println("Timeout."); return; }
    long avg = scale.read_average(20);
    saveTare(avg);
    Serial.printf("Tare set to %ld.\n", avg);
  } else if (cmd.startsWith("cal ")) {
    if (!hxAvailable) { Serial.println("HX711 not present."); return; }
    float knownG = cmd.substring(4).toFloat();
    if (knownG <= 0.0f) {
      Serial.println("Usage: cal <grams>   (known weight currently on scale, positive grams)");
      return;
    }
    Serial.printf("Calibrating with %.2fg on scale...\n", knownG);
    if (!scale.wait_ready_timeout(2000)) { Serial.println("Timeout."); return; }
    long rawAvg = scale.read_average(20);
    float counts = (float)(rawAvg - hxTareOffset);
    if (counts == 0.0f) { Serial.println("Zero counts — did you tare and place the weight?"); return; }
    float factor = counts / knownG;
    saveScale(factor);
    Serial.printf("Scale factor = %.4f counts/g. Saved.\n", factor);
  } else if (cmd == "reset") {
    prefs.clear();
    hxTareOffset  = 0;
    hxScaleFactor = DEFAULT_SCALE_FACTOR;
    hxCalibrated  = false;
    flagsByte &= ~0x04;
    Serial.println("NVS cleared. Reboot to re-init scale.");
  } else if (cmd == "scan") {
    Serial.println("Scanning I2C bus (write-probe + read-probe)...");
    uint8_t found = 0;
    for (uint8_t addr = 0x08; addr <= 0x77; addr++) {
      // Write-probe (classic scan)
      Wire.beginTransmission(addr);
      uint8_t wrErr = Wire.endTransmission();
      // Read-probe (for devices that NACK zero-byte writes)
      uint8_t rdBytes = Wire.requestFrom((int)addr, 1);
      if (wrErr == 0 || rdBytes == 1) {
        Serial.printf("  0x%02X  (wr=%u rd=%u)\n", addr, wrErr, rdBytes);
        found++;
      }
    }
    Serial.printf("Found %u device(s).\n", found);
  } else if (cmd == "bme_init") {
    Serial.println("Re-running BME280 init...");
    Wire.end();
    delay(100);
    if (I2C_SDA_PIN >= 0 && I2C_SCL_PIN >= 0) Wire.begin(I2C_SDA_PIN, I2C_SCL_PIN);
    else                                       Wire.begin();
    delay(50);
    bmeAvailable = initBME280();
    if (bmeAvailable) {
      flagsByte |= 0x01;
      bme.setSampling(
        Adafruit_BME280::MODE_FORCED,
        Adafruit_BME280::SAMPLING_X2,
        Adafruit_BME280::SAMPLING_X16,
        Adafruit_BME280::SAMPLING_X1,
        Adafruit_BME280::FILTER_X4,
        Adafruit_BME280::STANDBY_MS_0_5
      );
      Serial.println("BME280 re-initialized.");
      bme.takeForcedMeasurement();
      delay(20);
      Serial.printf("Post-init raw: T=%.2fC H=%.2f%% P=%.2fPa\n",
        bme.readTemperature(), bme.readHumidity(), bme.readPressure());
    } else {
      flagsByte &= ~0x01;
      Serial.println("BME280 re-init FAILED.");
    }
  } else if (cmd == "bme_raw") {
    if (!bmeAvailable) { Serial.println("BME280 not present."); return; }
    uint8_t id = bme.sensorID();
    Serial.printf("Chip ID: 0x%02X (expect 0x60)\n", id);
    bme.takeForcedMeasurement();
    delay(20);
    Serial.printf("Raw: T=%.4fC H=%.4f%% P=%.2fPa Alt=%.2fm\n",
      bme.readTemperature(), bme.readHumidity(), bme.readPressure(),
      bme.readAltitude(1013.25));
  } else if (cmd == "ble") {
    Serial.printf("Device name: %s\n", DEVICE_NAME);
    Serial.printf("BLE MAC: %s\n", NimBLEDevice::getAddress().toString().c_str());
    Serial.printf("Advertising: %s\n", pAdvertising->isAdvertising() ? "yes" : "no");
    Serial.printf("Payload size: 26 bytes MSD (protocol v0x04)\n");
  } else if (cmd == "audio") {
    if (!micAvailable) { Serial.println("INMP441 not initialized."); return; }
    uint8_t rms = 0xFF, peak = 0xFF;
    uint8_t bands[4] = { 0xFF, 0xFF, 0xFF, 0xFF };
    readAudioFeatures(&rms, &peak, bands);
    Serial.printf("RMS=-%udBFS  Peak=-%udBFS\n", rms, peak);
    Serial.printf("Bands:  low(100-200)=-%udBFS  midlow(200-400)=-%udBFS  midhigh(400-800)=-%udBFS  high(800-2000)=-%udBFS\n",
      bands[0], bands[1], bands[2], bands[3]);
    Serial.printf("(window=%d samples @ %luHz, Hann windowed)\n",
      (int)AUDIO_WINDOW_SAMPLES, (unsigned long)AUDIO_SAMPLE_RATE_HZ);
  } else if (cmd == "hx_init") {
    Serial.println("Re-running HX711 init...");
    hxAvailable = initHX711();
    if (hxAvailable) {
      flagsByte |= 0x02;
      loadCalibration();
      Serial.println("HX711 init OK.");
      long raw = scale.read_average(3);
      Serial.printf("Raw: %ld  (0x%06lX)\n", raw, raw & 0xFFFFFF);
      if (raw == 0x7FFFFF || raw == -0x800000) {
        Serial.println("*** Saturated — load cells not wired to analog inputs correctly. ***");
      }
    } else {
      flagsByte &= ~0x02;
      Serial.println("HX711 init FAILED (no ready signal).");
    }
  } else if (cmd == "hx_debug") {
    pinMode(HX711_DT_PIN, INPUT);
    pinMode(HX711_SCK_PIN, OUTPUT);
    digitalWrite(HX711_SCK_PIN, LOW);
    Serial.printf("DT pin %d state: %s\n",
      HX711_DT_PIN, digitalRead(HX711_DT_PIN) ? "HIGH (idle or floating)" : "LOW (data ready)");
    // Wait up to 500 ms for DT to go low (HX711 samples at 10 Hz so should happen fast)
    uint32_t t0 = millis();
    while (digitalRead(HX711_DT_PIN) && millis() - t0 < 500) delay(1);
    if (digitalRead(HX711_DT_PIN)) {
      Serial.println("DT never went low within 500ms. HX711 is not sampling (check VCC/GND/CLK).");
    } else {
      Serial.printf("DT went low after %lu ms. Attempting manual 24-bit read...\n", millis() - t0);
      int32_t v = 0;
      for (int i = 0; i < 24; i++) {
        digitalWrite(HX711_SCK_PIN, HIGH);
        delayMicroseconds(1);
        v = (v << 1) | digitalRead(HX711_DT_PIN);
        digitalWrite(HX711_SCK_PIN, LOW);
        delayMicroseconds(1);
      }
      // One extra pulse to set gain for next read
      digitalWrite(HX711_SCK_PIN, HIGH); delayMicroseconds(1);
      digitalWrite(HX711_SCK_PIN, LOW);
      if (v & 0x800000) v |= 0xFF000000;  // sign-extend 24→32
      Serial.printf("Raw 24-bit sample: %ld (0x%06lX)\n", (long)v, (long)(v & 0xFFFFFF));
    }
  } else if (cmd == "audio_raw") {
    if (!micAvailable || !i2sRxHandle) { Serial.println("INMP441 not initialized."); return; }
    static int32_t rawBuf[64];
    size_t br = 0;
    esp_err_t e = i2s_channel_read(i2sRxHandle, rawBuf, sizeof(rawBuf), &br, pdMS_TO_TICKS(300));
    Serial.printf("i2s_read err=%d bytes=%u\n", (int)e, (unsigned)br);
    size_t n = br / sizeof(int32_t);
    int32_t maxAbs = 0, minVal = INT32_MAX, maxVal = INT32_MIN;
    int zeros = 0;
    for (size_t i = 0; i < n; i++) {
      if (rawBuf[i] == 0) zeros++;
      if (rawBuf[i] < minVal) minVal = rawBuf[i];
      if (rawBuf[i] > maxVal) maxVal = rawBuf[i];
      int32_t s24 = rawBuf[i] >> 8;
      int32_t a = s24 < 0 ? -s24 : s24;
      if (a > maxAbs) maxAbs = a;
    }
    Serial.printf("samples=%u  zeros=%d  raw32 min=%ld max=%ld  peak24=%ld\n",
      (unsigned)n, zeros, (long)minVal, (long)maxVal, (long)maxAbs);
    Serial.print("first 16 raw32: ");
    for (size_t i = 0; i < 16 && i < n; i++) Serial.printf("%ld ", (long)rawBuf[i]);
    Serial.println();
  } else if (cmd == "reboot") {
    Serial.println("Rebooting...");
    Serial.flush();
    delay(100);
    ESP.restart();
  } else {
    Serial.printf("Unknown command: %s\n", cmd.c_str());
    Serial.println("Commands: status | tare | cal <grams> | reset | scan | bme_raw | bme_init | ble | audio | reboot");
  }
}

// ── Setup / Loop ────────────────────────────────────────────────────────────
void setup() {
  Serial.begin(115200);
  uint32_t t0 = millis();
  while (!Serial && (millis() - t0) < 1500) delay(10);

  Serial.println();
  Serial.println("=== BeeKeeper ESP32-C6 Node ===");
  Serial.printf("Device name: %s\n", DEVICE_NAME);

  if (I2C_SDA_PIN >= 0 && I2C_SCL_PIN >= 0) {
    Wire.begin(I2C_SDA_PIN, I2C_SCL_PIN);
  } else {
    Wire.begin();
  }
  // Let the BME280 power supply settle — some breakouts need this for
  // reliable calibration-register reads on first boot.
  delay(100);

  // BME280 first, BEFORE HX711 — the HX711 init toggles GPIOs that can
  // emit ground-bounce and upset adjacent I²C traces on shared power rails.
  bmeAvailable = initBME280();
  Serial.printf("BME280 %s\n",
                bmeAvailable ? "found + calibration verified" : "NOT FOUND (after 3 retries)");
  // (setSampling + plausibility check is already done inside initBME280)

  hxAvailable = initHX711();
  Serial.printf("HX711 %s (DT=%d, SCK=%d)\n",
                hxAvailable ? "found" : "NOT FOUND (no samples in 1s)",
                HX711_DT_PIN, HX711_SCK_PIN);

  micAvailable = initI2SMic();
  Serial.printf("INMP441 I2S %s (BCLK=%d, WS=%d, SD=%d)\n",
                micAvailable ? "ready" : "init FAILED",
                (int)I2S_BCLK_PIN, (int)I2S_WS_PIN, (int)I2S_SD_PIN);

  loadCalibration();
  Serial.printf("  NVS tare=%ld scale=%.4f calibrated=%s\n",
                hxTareOffset, hxScaleFactor, hxCalibrated ? "yes" : "no");

  NimBLEDevice::init(DEVICE_NAME);
  NimBLEDevice::setPower(ESP_PWR_LVL_P9);

  pAdvertising = NimBLEDevice::getAdvertising();
  pAdvertising->setConnectableMode(BLE_GAP_CONN_MODE_NON);
  pAdvertising->setDiscoverableMode(BLE_GAP_DISC_MODE_GEN);
  pAdvertising->setMinInterval(0x00A0);  // 100ms
  pAdvertising->setMaxInterval(0x00A0);

  // Scan response carries the device name (active scanners pull it on request).
  NimBLEAdvertisementData scanRespData;
  scanRespData.setName(DEVICE_NAME);
  pAdvertising->setScanResponseData(scanRespData);

  flagsByte |= 0x08;  // first-boot
  Serial.println("BLE advertising started. Type 'status' for details.");
}

void loop() {
  // Handle serial commands
  if (Serial.available()) {
    String line = Serial.readStringUntil('\n');
    handleSerialCommand(line);
  }

  // Build + set advertisement
  uint8_t payload[26];
  buildAdvPayload(payload);

  // 31-byte legacy-adv budget: 3 (flags) + 28 (26B MSD + header) = 31 bytes used.
  // Name goes in scan response so any active scanner still gets it.
  NimBLEAdvertisementData advData;
  advData.setFlags(BLE_HS_ADV_F_DISC_GEN | BLE_HS_ADV_F_BREDR_UNSUP);
  advData.setManufacturerData(std::string((char*)payload, sizeof(payload)));
  pAdvertising->setAdvertisementData(advData);

  pAdvertising->stop();
  pAdvertising->start();

  int16_t  tempRaw = (int16_t)(payload[6] | (payload[7] << 8));
  uint16_t humRaw  = (uint16_t)(payload[8] | (payload[9] << 8));
  uint32_t pRaw    = (uint32_t)payload[10] | ((uint32_t)payload[11] << 8) | ((uint32_t)payload[12] << 16);
  int32_t  wRaw    = (int32_t)((uint32_t)payload[13] | ((uint32_t)payload[14] << 8)
                               | ((uint32_t)payload[15] << 16) | ((uint32_t)payload[16] << 24));
  uint8_t  audRms  = payload[19];
  uint8_t  audPeak = payload[20];
  uint8_t  bLo     = payload[21];
  uint8_t  bML     = payload[22];
  uint8_t  bMH     = payload[23];
  uint8_t  bHi     = payload[24];

  Serial.printf("adv: T=%.2fC H=%.2f%% P=%luPa W=%ldg RMS=-%udBFS Pk=-%udBFS B[%u,%u,%u,%u] uptime=%lus flags=0x%02X\n",
                tempRaw / 100.0f, humRaw / 100.0f,
                (unsigned long)pRaw, (long)wRaw,
                audRms, audPeak,
                bLo, bML, bMH, bHi,
                (unsigned long)(millis() / 1000), flagsByte);

  if (flagsByte & 0x08) flagsByte &= ~0x08;

  delay(ADV_INTERVAL_MS);
}
