import { createHash, randomBytes, timingSafeEqual } from "crypto";

type RegisteredUser = {
  saltHex: string;
  verifierHex: string;
};

type AuthSession = {
  username: string;
  expectedClientProofHex: string;
  serverProofHex: string;
  createdAt: number;
};

const N_HEX =
  "AC6BDB41324A9A9BF166DE5E1389582FAF72B6651987EE07FC3192943DB56050" +
  "A37329CBB4A099ED8193E0757767A13DD52312AB4B03310DCD7F48A9DA04FD50" +
  "E8083969EDB767B0CF6096D8A1F9A4F1E5A8E4F1232EEF28183C3FE3B1B4C6FAD7" +
  "33BB5FCBC2EC22005C58EF1837D1683B2C6F34A26C1B2EFFA886B423861285C97F" +
  "FFFFFFFFFFFFFFFF";

const G = 2n;
const N = hexToBigInt(N_HEX);
const N_BYTES = hexToBuffer(N_HEX).length;
const SESSION_TTL_MS = 5 * 60 * 1000;

const users = new Map<string, RegisteredUser>();
const authSessions = new Map<string, AuthSession>();

function sha256(...chunks: Buffer[]): Buffer {
  const hash = createHash("sha256");
  for (const chunk of chunks) {
    hash.update(chunk);
  }
  return hash.digest();
}

function hexToBuffer(hex: string): Buffer {
  return Buffer.from(hex, "hex");
}

function hexToBigInt(hex: string): bigint {
  return BigInt(`0x${hex}`);
}

function bigIntToBuffer(value: bigint, paddedBytes = N_BYTES): Buffer {
  let hex = value.toString(16);
  if (hex.length % 2 !== 0) {
    hex = `0${hex}`;
  }
  const raw = Buffer.from(hex, "hex");
  if (raw.length >= paddedBytes) {
    return raw;
  }
  return Buffer.concat([Buffer.alloc(paddedBytes - raw.length, 0), raw]);
}

function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  if (modulus === 1n) {
    return 0n;
  }

  let result = 1n;
  let b = base % modulus;
  let e = exponent;

  while (e > 0n) {
    if (e & 1n) {
      result = (result * b) % modulus;
    }
    e >>= 1n;
    b = (b * b) % modulus;
  }

  return result;
}

function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

function randomBigInt(bytes: number): bigint {
  return hexToBigInt(randomBytes(bytes).toString("hex"));
}

function padToN(value: bigint): Buffer {
  return bigIntToBuffer(value, N_BYTES);
}

function computeK(): bigint {
  return hexToBigInt(sha256(padToN(N), padToN(G)).toString("hex"));
}

function computeU(A: bigint, B: bigint): bigint {
  return hexToBigInt(sha256(padToN(A), padToN(B)).toString("hex"));
}

function computeX(username: string, password: string, saltHex: string): bigint {
  const identityHash = sha256(
    Buffer.from(`${normalizeUsername(username)}:${password}`, "utf8"),
  );
  const xHash = sha256(hexToBuffer(saltHex), identityHash);
  return hexToBigInt(xHash.toString("hex"));
}

function cleanupExpiredSessions() {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [sessionId, session] of authSessions.entries()) {
    if (session.createdAt < cutoff) {
      authSessions.delete(sessionId);
    }
  }
}

const k = computeK();

export const srpService = {
  getParams() {
    return {
      N: N_HEX,
      g: G.toString(10),
      hash: "SHA-256",
      protocol: "SRP-6a",
    };
  },

  register(username: string, password: string) {
    const normalized = normalizeUsername(username);
    if (!normalized || !password) {
      throw new Error("Username and password are required");
    }

    const salt = randomBytes(16);
    const saltHex = salt.toString("hex");
    const x = computeX(normalized, password, saltHex);
    const verifier = modPow(G, x, N);

    users.set(normalized, {
      saltHex,
      verifierHex: verifier.toString(16),
    });

    return { username: normalized };
  },

  challenge(username: string, clientPublicHex: string) {
    cleanupExpiredSessions();

    const normalized = normalizeUsername(username);
    const user = users.get(normalized);
    if (!user) {
      throw new Error("User not found");
    }

    const A = hexToBigInt(clientPublicHex);
    if (A % N === 0n) {
      throw new Error("Invalid client public value");
    }

    const v = hexToBigInt(user.verifierHex);
    const b = randomBigInt(32);
    const gb = modPow(G, b, N);
    const B = (k * v + gb) % N;

    const u = computeU(A, B);
    if (u === 0n) {
      throw new Error("Invalid scramble value");
    }

    const vu = modPow(v, u, N);
    const S = modPow((A * vu) % N, b, N);
    const K = sha256(padToN(S));

    const expectedClientProof = sha256(padToN(A), padToN(B), K).toString("hex");
    const serverProof = sha256(
      padToN(A),
      hexToBuffer(expectedClientProof),
      K,
    ).toString("hex");

    const sessionId = randomBytes(16).toString("hex");
    authSessions.set(sessionId, {
      username: normalized,
      expectedClientProofHex: expectedClientProof,
      serverProofHex: serverProof,
      createdAt: Date.now(),
    });

    return {
      salt: user.saltHex,
      serverPublic: B.toString(16),
      sessionId,
    };
  },

  verify(sessionId: string, clientProofHex: string) {
    cleanupExpiredSessions();

    const session = authSessions.get(sessionId);
    if (!session) {
      throw new Error("Session expired or invalid");
    }

    const expected = hexToBuffer(session.expectedClientProofHex);
    const received = hexToBuffer(clientProofHex);

    if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
      throw new Error("Invalid SRP client proof");
    }

    authSessions.delete(sessionId);

    return {
      username: session.username,
      serverProof: session.serverProofHex,
      token: randomBytes(24).toString("hex"),
    };
  },
};
