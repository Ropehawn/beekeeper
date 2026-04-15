// Uploader — drains the local SQLite buffer every N seconds and POSTs to
// /api/v1/hubs/ingest. On success, rows are deleted from buffer. On failure,
// they stay — next tick retries.

class Uploader {
  constructor({ apiBaseUrl, hubKey, batchSize, buffer, logger = console }) {
    this.apiBaseUrl = apiBaseUrl;
    this.hubKey = hubKey;
    this.batchSize = batchSize;
    this.buffer = buffer;
    this.logger = logger;
  }

  async tick() {
    if (!this.hubKey) return { uploaded: 0, pending: this.buffer.pending() };

    let uploaded = 0;
    while (true) {
      const { batch, lastId } = this.buffer.drain(this.batchSize);
      if (!batch.length) break;

      try {
        const res = await fetch(`${this.apiBaseUrl}/api/v1/hubs/ingest`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Hub-Key": this.hubKey,
          },
          body: JSON.stringify({ readings: batch }),
        });

        if (!res.ok) {
          const text = await res.text().catch(() => "");
          this.logger.warn({ msg: "upload.fail", status: res.status, body: text.slice(0, 200) });
          break; // leave buffer intact, retry next tick
        }

        this.buffer.acknowledge(lastId);
        uploaded += batch.length;
      } catch (err) {
        this.logger.warn({ msg: "upload.err", err: err.message });
        break;
      }
    }

    return { uploaded, pending: this.buffer.pending() };
  }

  async heartbeat(stats) {
    if (!this.hubKey) return;

    try {
      const res = await fetch(`${this.apiBaseUrl}/api/v1/hubs/heartbeat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Hub-Key": this.hubKey,
        },
        body: JSON.stringify(stats),
      });
      if (!res.ok) {
        this.logger.warn({ msg: "heartbeat.fail", status: res.status });
      }
    } catch (err) {
      this.logger.warn({ msg: "heartbeat.err", err: err.message });
    }
  }

  async fetchConfig() {
    if (!this.hubKey) return null;
    try {
      const res = await fetch(`${this.apiBaseUrl}/api/v1/hubs/config`, {
        method: "GET",
        headers: { "X-Hub-Key": this.hubKey },
      });
      if (!res.ok) return null;
      return await res.json();
    } catch (err) {
      this.logger.warn({ msg: "config.err", err: err.message });
      return null;
    }
  }
}

export { Uploader };
