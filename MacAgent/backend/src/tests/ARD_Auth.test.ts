// Apple sign-in: what our client encrypts, a server must be able to decrypt.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { test } from "node:test";
import { ARD_Response } from "../ARD_Auth.js";
import { ardDecrypt } from "./fakeVnc.js";

function exchange(username: string, password: string) {
  const server = crypto.getDiffieHellman("modp2");
  server.generateKeys();
  const prime = server.getPrime();
  const serverPublic = Buffer.concat([Buffer.alloc(prime.length), server.getPublicKey()]).subarray(-prime.length);
  const response = ARD_Response(server.getGenerator(), prime, serverPublic, username, password);
  return { response, keyLen: prime.length, login: ardDecrypt(server, prime.length, response) };
}

test("the server recovers the username and password", () => {
  const { login } = exchange("agent", "correct horse battery staple");
  assert.deepEqual(login, { username: "agent", password: "correct horse battery staple" });
});

test("the reply is 128 encrypted bytes plus a public key as long as the prime", () => {
  const { response, keyLen } = exchange("agent", "pw");
  assert.equal(response.length, 128 + keyLen);
});

test("the credentials never appear unencrypted", () => {
  const { response } = exchange("agent", "s3cret-password");
  assert.ok(!response.includes("s3cret-password"));
  assert.ok(!response.includes("agent"));
});

test("two sign-ins with the same password look different", () => {
  assert.notDeepEqual(exchange("agent", "pw").response, exchange("agent", "pw").response);
});

test("non-ASCII passwords survive", () => {
  assert.equal(exchange("agent", "pässwörd-日本").login.password, "pässwörd-日本");
});

test("names and passwords are cut to 63 bytes so each still ends in a NUL", () => {
  const { login } = exchange("u".repeat(100), "p".repeat(100));
  assert.equal(login.username, "u".repeat(63));
  assert.equal(login.password, "p".repeat(63));
});
