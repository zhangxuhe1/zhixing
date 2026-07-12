import XCTest
@testable import Zhixing

/// 邮箱登录纯逻辑：本地校验、倒计时状态机、错误映射。全部时间显式注入，无隐式 Date()。
final class EmailSignInLogicTests: XCTestCase {
    func testEmailValidation() {
        XCTAssertTrue(EmailAuthRules.isValidEmail("a@b.co"))
        XCTAssertTrue(EmailAuthRules.isValidEmail("  a@b.co  ")) // 首尾空白由 trim 吸收
        XCTAssertFalse(EmailAuthRules.isValidEmail(""))
        XCTAssertFalse(EmailAuthRules.isValidEmail("ab.co"))
        XCTAssertFalse(EmailAuthRules.isValidEmail("a@b")) // 无 TLD
        XCTAssertFalse(EmailAuthRules.isValidEmail("a @b.co")) // 内部空白
    }

    func testCodeValidation() {
        XCTAssertTrue(EmailAuthRules.isValidCode("012345"))
        XCTAssertFalse(EmailAuthRules.isValidCode("12345"))
        XCTAssertFalse(EmailAuthRules.isValidCode("1234567"))
        XCTAssertFalse(EmailAuthRules.isValidCode("12345a"))
        XCTAssertFalse(EmailAuthRules.isValidCode(""))
    }

    func testCooldownStateMachine() {
        var cd = SendCooldown()
        let t0 = Date(timeIntervalSince1970: 1_000_000)
        XCTAssertFalse(cd.isCoolingDown(now: t0))
        XCTAssertEqual(cd.remaining(now: t0), 0)

        cd.start(now: t0)
        // 与服务端 EMAIL_CODE.cooldownMs（60s）一致
        XCTAssertEqual(cd.remaining(now: t0), 60)
        // 向上取整：还剩 0.5 秒时显示 1，不显示 0 却仍禁用
        XCTAssertEqual(cd.remaining(now: t0.addingTimeInterval(59.5)), 1)
        XCTAssertTrue(cd.isCoolingDown(now: t0.addingTimeInterval(59.9)))
        XCTAssertFalse(cd.isCoolingDown(now: t0.addingTimeInterval(60)))
        XCTAssertEqual(cd.remaining(now: t0.addingTimeInterval(120)), 0)
    }

    func testErrorMessageMapsByStatusOnly() {
        // 429：{error} 体与 authRateLimit 插件异形体 → 同一文案（只看 status，不解析 body）
        XCTAssertEqual(
            EmailAuthRules.message(for: APIError.status(429, #"{"error":"rate_limited"}"#)),
            "操作太频繁，请稍后再试")
        XCTAssertEqual(
            EmailAuthRules.message(for: APIError.status(429, "限流插件的另一种体形")),
            "操作太频繁，请稍后再试")
        XCTAssertEqual(
            EmailAuthRules.message(for: APIError.status(401, #"{"error":"invalid_code"}"#)),
            "验证码错误或已失效，请重新获取")
        XCTAssertEqual(
            EmailAuthRules.message(for: APIError.status(400, "invalid_body")),
            "操作失败，请检查网络后重试")
        XCTAssertEqual(
            EmailAuthRules.message(for: URLError(.notConnectedToInternet)),
            "操作失败，请检查网络后重试")
    }
}
