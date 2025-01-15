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

export type SSH_CONNECT = {
    password: any;
    privateKey?: undefined;
    host: any;
    username: any;
} | {
    privateKey: any;
    password?: undefined;
    host: any;
    username: any;
}
export type SSH_CONFIG = {
    host: string;
    username: string;
    authMethod: "password" | "privateKey";
    saveCredentials: boolean;
    password?: string | undefined;
    privateKeyText?: string | undefined;
    privateKeyFile?: File | undefined;
    localName?: string | undefined;
}
export type SSH_CONFIG_DATA = {
    info: {
        uid: string;
        sessionId: string;
    }
    config: SSH_CONFIG
}
export type SSH_RESIZE_WINDOW={
    uid:string
    size:{rows: number, cols: number}
}