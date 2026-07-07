import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

export type AppleJwks = JWTVerifyGetKey;

export function remoteAppleJwks(): AppleJwks {
  return createRemoteJWKSet(new URL("https://appleid.apple.com/auth/keys"));
}

export async function verifyAppleIdentityToken(
  token: string,
  jwks: AppleJwks,
  bundleId: string,
): Promise<{ sub: string }> {
  const { payload } = await jwtVerify(token, jwks, {
    issuer: "https://appleid.apple.com",
    audience: bundleId,
    algorithms: ["RS256"],
  });
  if (!payload.sub) throw new Error("apple token missing sub");
  return { sub: payload.sub };
}
