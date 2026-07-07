import { SignJWT, jwtVerify } from "jose";
import { config } from "./config.js";

const secret = () => new TextEncoder().encode(config.sessionSecret);

export async function signSession(userId: string): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime("180d")
    .sign(secret());
}

export async function verifySession(token: string): Promise<string> {
  const { payload } = await jwtVerify(token, secret());
  if (!payload.sub) throw new Error("session token missing sub");
  return payload.sub;
}
