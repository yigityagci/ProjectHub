import { describe, expect, it } from "vitest";
import { encryptSecret, decryptSecret } from "../src/core/secret-box.js";

describe("core/secret-box (AES-256-GCM envelope for at-rest secrets)", () => {
  it("round-trips: decrypt(encrypt(plaintext)) === plaintext", () => {
    const plaintext = "hunter2-super-secret-smtp-password";
    const envelope = encryptSecret(plaintext);
    expect(envelope).not.toBe(plaintext);
    expect(envelope.startsWith("v1:")).toBe(true);
    expect(decryptSecret(envelope)).toBe(plaintext);
  });

  it("produces a different envelope each time (random IV) even for the same plaintext", () => {
    const plaintext = "same-secret-both-times";
    const first = encryptSecret(plaintext);
    const second = encryptSecret(plaintext);
    expect(first).not.toBe(second);
    expect(decryptSecret(first)).toBe(plaintext);
    expect(decryptSecret(second)).toBe(plaintext);
  });

  it("throws on tampering: flipping a byte in the ciphertext portion fails auth-tag verification", () => {
    const envelope = encryptSecret("do-not-tamper-with-me");
    const parts = envelope.split(":");
    const ciphertext = parts[3]!;
    // Flip the first character of the ciphertext to corrupt it while
    // keeping the envelope structurally well-formed.
    const flippedChar = ciphertext[0] === "A" ? "B" : "A";
    const tampered = [parts[0], parts[1], parts[2], flippedChar + ciphertext.slice(1)].join(":");
    expect(() => decryptSecret(tampered)).toThrow();
  });

  it("throws on an unknown envelope version", () => {
    const envelope = encryptSecret("versioned-secret");
    const parts = envelope.split(":");
    const wrongVersion = ["v2", parts[1], parts[2], parts[3]].join(":");
    expect(() => decryptSecret(wrongVersion)).toThrow();
  });

  it("throws on a malformed envelope (wrong number of parts)", () => {
    expect(() => decryptSecret("not-a-real-envelope")).toThrow();
    expect(() => decryptSecret("v1:only:three:parts:here")).toThrow();
  });
});
