"""
Raw HCI BLE scanner — bypasses BlueZ to read LE advertising reports directly.
Parses iBeacon packets with Fanstel company ID 0x0634.
"""
import socket
import struct
import sys

# HCI constants
HCI_EVENT_PKT = 0x04
EVT_LE_META = 0x3E
EVT_LE_ADVERTISING_REPORT = 0x02

# Open raw HCI socket
sock = socket.socket(socket.AF_BLUETOOTH, socket.SOCK_RAW, socket.BTPROTO_HCI)
sock.bind((0,))  # bind to hci0

# Enable LE scanning
# hci_le_set_scan_parameters: LE_Scan_Type=0x01 (active), interval=0x0010, window=0x0010, own_addr=0x00, filter=0x00
sock.send(bytes([0x01, 0x0B, 0x20, 0x07, 0x01, 0x10, 0x00, 0x10, 0x00, 0x00, 0x00]))
# hci_le_set_scan_enable: enable=0x01, filter_dups=0x00
sock.send(bytes([0x01, 0x0C, 0x20, 0x02, 0x01, 0x00]))

print("Raw HCI scanning for 30 seconds... looking for Fanstel 0x0634 / iBeacon", flush=True)

import time
start = time.time()
found_fanstel = False

while time.time() - start < 30:
    try:
        data = sock.recv(1024)
    except socket.timeout:
        continue
    
    if len(data) < 3:
        continue
    
    pkt_type = data[0]
    if pkt_type != HCI_EVENT_PKT:
        continue
    
    event_code = data[1]
    if event_code != EVT_LE_META:
        continue
    
    subevent = data[3]
    if subevent != EVT_LE_ADVERTISING_REPORT:
        continue
    
    # Parse LE advertising report
    num_reports = data[4]
    offset = 5
    
    for i in range(num_reports):
        if offset + 9 > len(data):
            break
        
        evt_type = data[offset]
        addr_type = data[offset + 1]
        addr = data[offset + 2:offset + 8]
        addr_str = ':'.join(f'{b:02X}' for b in reversed(addr))
        data_len = data[offset + 8]
        adv_data = data[offset + 9:offset + 9 + data_len]
        rssi = struct.unpack('b', bytes([data[offset + 9 + data_len]]))[0] if offset + 9 + data_len < len(data) else 0
        
        offset += 9 + data_len + 1
        
        # Parse AD structures in adv_data
        pos = 0
        while pos < len(adv_data) - 1:
            ad_len = adv_data[pos]
            if ad_len == 0 or pos + ad_len >= len(adv_data):
                break
            ad_type = adv_data[pos + 1]
            ad_payload = adv_data[pos + 2:pos + 1 + ad_len]
            
            # 0xFF = Manufacturer Specific Data
            if ad_type == 0xFF and len(ad_payload) >= 2:
                company_id = struct.unpack('<H', ad_payload[:2])[0]
                mfr_data = ad_payload[2:]
                
                if company_id == 0x0634:  # Fanstel
                    found_fanstel = True
                    print(f"\n*** FANSTEL SC833F FOUND ***", flush=True)
                    print(f"  MAC: {addr_str} (type: {'random' if addr_type else 'public'})", flush=True)
                    print(f"  RSSI: {rssi} dBm", flush=True)
                    print(f"  Company ID: 0x{company_id:04X} (Fanstel)", flush=True)
                    print(f"  Raw mfr data: {mfr_data.hex()}", flush=True)
                    
                    # Parse iBeacon format: 02 15 <UUID 16B> <Major 2B> <Minor 2B> <TxPow 1B>
                    if len(mfr_data) >= 21 and mfr_data[0] == 0x02 and mfr_data[1] == 0x15:
                        uuid = mfr_data[2:18]
                        uuid_str = f"{uuid[:4].hex()}-{uuid[4:6].hex()}-{uuid[6:8].hex()}-{uuid[8:10].hex()}-{uuid[10:].hex()}"
                        major = struct.unpack('>H', mfr_data[18:20])[0]
                        minor = struct.unpack('>H', mfr_data[20:22])[0]
                        tx_power = struct.unpack('b', bytes([mfr_data[22]]))[0] if len(mfr_data) > 22 else 0
                        
                        print(f"  UUID: {uuid_str}", flush=True)
                        print(f"  Major (temp): {major} °C", flush=True)
                        print(f"  Minor (humidity): {minor} %RH", flush=True)
                        print(f"  TX Power: {tx_power} dBm", flush=True)
            
            pos += 1 + ad_len

# Disable scanning
sock.send(bytes([0x01, 0x0C, 0x20, 0x02, 0x00, 0x00]))
sock.close()

if not found_fanstel:
    print("\nNo Fanstel 0x0634 device found in 30 seconds.", flush=True)
else:
    print("\nScan complete.", flush=True)
