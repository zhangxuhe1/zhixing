import XCTest
@testable import Zhixing

/// `tripDateRange` 契约：CST（+08:00，与服务端 `time.ts` 的 `cstParts` 同一固定偏移语义）日历分桶下的
/// 展示格式化——同日不出现分隔符；同年同月省略月份重复；同年跨月省略年份重复；跨年两端各自完整。
/// 用例里的日期一律带显式 `+08:00` 偏移构造（而非 `Z`/依赖 `TimeZone.current`），使断言与宿主机
/// （开发机/CI）的本地时区完全无关——不需要在测试里覆写 `TimeZone`/`Calendar.current`。
final class TripFormatTests: XCTestCase {
    private func cstDate(_ iso: String) -> Date {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        guard let date = formatter.date(from: iso) else {
            XCTFail("无法解析日期 \(iso)")
            return Date()
        }
        return date
    }

    func testSameYearSameMonthOmitsYearAndMonthOnEnd() {
        let start = cstDate("2024-05-01T12:00:00+08:00")
        let end = cstDate("2024-05-04T12:00:00+08:00")
        XCTAssertEqual(tripDateRange(start, end), "2024年5月1日–4日")
    }

    func testSameYearDifferentMonthOmitsYearOnEnd() {
        let start = cstDate("2024-05-30T12:00:00+08:00")
        let end = cstDate("2024-06-02T12:00:00+08:00")
        XCTAssertEqual(tripDateRange(start, end), "2024年5月30日–6月2日")
    }

    func testDifferentYearKeepsBothFullyQualified() {
        let start = cstDate("2024-12-30T12:00:00+08:00")
        let end = cstDate("2025-01-02T12:00:00+08:00")
        XCTAssertEqual(tripDateRange(start, end), "2024年12月30日–2025年1月2日")
    }

    func testSameCalendarDayHasNoSeparator() {
        // 同一 CST 日历日内的两个不同时刻（非同一瞬间），仍应折叠成单天展示。
        let start = cstDate("2024-05-01T00:30:00+08:00")
        let end = cstDate("2024-05-01T23:30:00+08:00")
        XCTAssertEqual(tripDateRange(start, end), "2024年5月1日")
    }

    /// 边界防抖动核验：+08:00 偏移日界两侧（CST 00:00 前后）在 UTC 里其实还是前一天，
    /// 若实现误用了未加偏移的 `Calendar.current`（宿主机若非 +08:00 时区）会在这类用例上先炸。
    func testHonorsFixedCSTOffsetNotHostTimeZone() {
        let start = cstDate("2024-05-01T00:05:00+08:00") // UTC: 2024-04-30T16:05:00Z
        let end = cstDate("2024-05-01T00:50:00+08:00") // UTC: 2024-04-30T16:50:00Z
        XCTAssertEqual(tripDateRange(start, end), "2024年5月1日")
    }
}
