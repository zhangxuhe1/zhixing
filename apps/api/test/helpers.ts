import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { buildApp } from "../src/app.js";

export const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://zhixing:zhixing@localhost:5433/zhixing_test";

const applePair = await generateKeyPair("RS256");
export const appleJwks = createLocalJWKSet({
  keys: [{ ...(await exportJWK(applePair.publicKey)), alg: "RS256", kid: "test-key" }],
});

/** 造一个"Apple 签发"的 identityToken（测试密钥对） */
export async function fakeAppleToken(sub: string, audience = "app.zhixing.ios") {
  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer("https://appleid.apple.com")
    .setAudience(audience)
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(applePair.privateKey);
}

export function testApp() {
  return buildApp({ databaseUrl: TEST_DB_URL, appleJwks, devAuth: true, s3Bucket: "zhixing-test" });
}

export async function resetDb(app: ReturnType<typeof buildApp>) {
  await app.prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "FootprintPhoto","Footprint","CardBlock","Card","Place","User","SearchMiss" RESTART IDENTITY CASCADE',
  );
}

export const ADMIN_AUTH = { authorization: "Bearer dev-admin-token" };

/** 走 dev 登录拿到用户 Bearer 头 */
export async function userAuth(app: ReturnType<typeof buildApp>, appleSub = "sub-1") {
  const res = await app.inject({ method: "POST", url: "/auth/dev", payload: { appleSub } });
  const { token, user } = res.json();
  return { headers: { authorization: `Bearer ${token}` }, user };
}
