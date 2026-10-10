//Planning
//Sper cool authentication idea
// using Diffie- Helman key exchange
//Important details: Serversends a generator (u16), a prime for modulus, key length (u16), public key
// we would answer with AES-128-ECB(MD5(shared secret number), credentials(128 bytes long)) and client public key 
//credentials include 64 bytes of user name and 64 bytes of password
//Chose utf8 for text to binary conversion


import crypto from "node:crypto"

function leftPad(buffer: Buffer, len: number): Buffer {

  if (buffer.length >= len){
    return buffer.subarray(buffer.length - len);
  } 
  return Buffer.concat([Buffer.alloc(len - buffer.length), buffer]); 
}

export function ARD_Response(
  generator: Buffer, 
  prime: Buffer, 
  serverPublicKey: Buffer, 
  username: string,
  password: string,
): Buffer {
  const keyLen = prime.length; 
  const dh = crypto.createDiffieHellman(prime, generator);
  dh.generateKeys();

  const clientPublic = leftPad(dh.getPublicKey(), keyLen);
  const shared = leftPad(dh.computeSecret(serverPublicKey), keyLen);
  const aesKey = crypto.createHash("md5").update(shared).digest();
  const credentials = crypto.randomBytes(128); // generates 128 cryptographically secure random bytes.
  const userName = Buffer.from(username, "utf8").subarray(0, 63);
  const passwordBuffer = Buffer.from(password, "utf8").subarray(0, 63);
  userName.copy(credentials, 0);
  credentials[userName.length] = 0; //writes a zero byte after the username, marking where the text ends.
  passwordBuffer.copy(credentials, 64);
  credentials[64 + passwordBuffer.length] = 0;

  const cipher = crypto.createCipheriv("aes-128-ecb", aesKey, null);
  cipher.setAutoPadding(false); //cancel node's autopadding
  const encrypted = Buffer.concat([cipher.update(credentials), cipher.final()]);
  return Buffer.concat([encrypted, clientPublic]);
}