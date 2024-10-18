export interface SSH_HANDSHAKE {
    "kex": string,
    "serverHostKey": string,
    "cs": {
        "cipher": string,
        "mac": string,
        "compress": string,
        "lang": string
    },
    "sc": {
        "cipher": string,
        "mac": string,
        "compress": string,
        "lang": string
    }
}