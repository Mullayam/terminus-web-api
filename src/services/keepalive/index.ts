import { Logging } from "@enjoys/express-utils/logger";
import { __CONFIG__ } from "../../utils/constant";

/**
 * Periodically pings a Render service so its free instance never idles out
 * (Render spins containers down after ~15 min without traffic). This is a
 * plain interval timer, not an OS cron — it lives and dies with the process.
 */
class KeepAliveService {
    private timer: NodeJS.Timeout | null = null;

    start(): void {
        const { ENABLED, URL, INTERVAL_MINUTES } = __CONFIG__.KEEPALIVE;

        if (!ENABLED) {
            Logging.dev("[keepalive] Disabled (KEEPALIVE_ENABLED != true)", "notice");
            return;
        }
        if (this.timer) return;

        const intervalMs = Math.max(1, INTERVAL_MINUTES) * 60_000;
        // Fire once now so a fresh deploy warms the peer immediately.
        void this.ping();
        this.timer = setInterval(() => void this.ping(), intervalMs);
        // Don't let the pinger hold the event loop open during shutdown.
        this.timer.unref?.();

        Logging.dev(`[keepalive] Pinging ${URL} every ${INTERVAL_MINUTES}m`, "info");
    }

    stop(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    private async ping(): Promise<void> {
        const { URL, TIMEOUT_MS } = __CONFIG__.KEEPALIVE;
        const controller = new AbortController();
        const abort = setTimeout(() => controller.abort(), TIMEOUT_MS);

        try {
            const res = await fetch(URL, {
                method: "GET",
                signal: controller.signal,
                headers: { "user-agent": "terminus-keepalive" },
            });
            Logging.dev(`[keepalive] ${URL} -> ${res.status}`, "info");
        } catch (err: any) {
            Logging.dev(`[keepalive] ${URL} failed: ${err?.message ?? err}`, "error");
        } finally {
            clearTimeout(abort);
        }
    }
}

export const keepAliveService = new KeepAliveService();
