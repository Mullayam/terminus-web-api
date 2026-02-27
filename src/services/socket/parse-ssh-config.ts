import { ConnectConfig } from "ssh2";

/**
 * Parse raw SSH credentials (from Redis / client payload) into ssh2 ConnectConfig.
 *
 * Accepts either a JSON string or an object with:
 *   host, port?, username, authMethod ("password"|"privateKey"),
 *   password?, privateKeyText?
 */
export function parseSSHConfig(data: any): ConnectConfig {
    if (typeof data === "string") {
        data = JSON.parse(data);
    }

    const authOpts =
        data.authMethod === "password"
            ? { password: data.password }
            : { privateKey: data.privateKeyText };

    return {
        host: data.host,
        port: +data.port || 22,
        username: data.username,
        ...authOpts,
    };
}
