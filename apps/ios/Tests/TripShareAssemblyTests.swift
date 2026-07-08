import UIKit
import XCTest
@testable import Zhixing

/// TripShareScreen 装配阶段几个纯函数的契约（分享长图 I8）：
/// - `dedupPreservingOrder`：城市名去重保序。
/// - `firstNonEmptyExcerpts`：跳过空文字、按 `Character`（而非 UTF-8 字节）截断、满额即停。
/// - `topPhotoRefs`：按足迹日期倒序拍平取前 N 张，`limit`（ImageRenderer 内存上界）硬停。
/// - `TripShareCard.columns(forPhotoCount:)`：九宫格三档版式分界。
final class TripShareAssemblyTests: XCTestCase {
    // MARK: - dedupPreservingOrder

    func testDedupPreservingOrderKeepsFirstOccurrenceOrder() {
        let result = dedupPreservingOrder(["北京", "上海", "北京", "广州", "上海"])
        XCTAssertEqual(result, ["北京", "上海", "广州"])
    }

    func testDedupPreservingOrderEmptyInput() {
        XCTAssertEqual(dedupPreservingOrder([]), [])
    }

    // MARK: - firstNonEmptyExcerpts

    /// 同时验证三条规则：跳过空文字；按字符（不按 UTF-8 字节）截断——若误用字节计数，
    /// 中文字符串会被腰斩成乱码前缀；凑够 limit 条立即停止，不再处理后面的候选。
    func testFirstNonEmptyExcerptsSkipsEmptyTruncatesByCharacterAndStopsAtLimit() {
        let texts = ["", "ABCDE", "", "一二三四五六七八九十", "第三条", "第四条不该出现"]

        let result = firstNonEmptyExcerpts(texts, limit: 3, maxLength: 3)

        XCTAssertEqual(result, ["ABC", "一二三", "第三条"])
    }

    func testFirstNonEmptyExcerptsShorterThanMaxLengthIsUnchanged() {
        let result = firstNonEmptyExcerpts(["短文字"], limit: 3, maxLength: 60)
        XCTAssertEqual(result, ["短文字"])
    }

    func testFirstNonEmptyExcerptsAllEmptyProducesEmptyResult() {
        XCTAssertEqual(firstNonEmptyExcerpts(["", ""], limit: 3, maxLength: 60), [])
    }

    // MARK: - topPhotoRefs

    private func sampleFootprint(id: String, date: Date, photoIds: [String]) -> Footprint {
        Footprint(
            id: id, placeId: "place-\(id)", text: nil, date: date,
            place: PlaceRef(id: "place-\(id)", name: "地点\(id)"),
            photos: photoIds.map { FootprintPhotoMeta(id: $0, takenAt: nil) },
            visibility: "PRIVATE", reviewStatus: "APPROVED",
            likeCount: 0, viewCount: 0, tripId: "trip-1")
    }

    func testTopPhotoRefsOrdersByFootprintDateDescendingAndFlattensPerFootprintOrder() {
        let day1 = Date(timeIntervalSince1970: 0)
        let day2 = Date(timeIntervalSince1970: 86400)
        let day3 = Date(timeIntervalSince1970: 172800)
        let footprints = [
            sampleFootprint(id: "A", date: day1, photoIds: ["pA1", "pA2"]),
            sampleFootprint(id: "B", date: day3, photoIds: ["pB1"]),
            sampleFootprint(id: "C", date: day2, photoIds: ["pC1", "pC2", "pC3"]),
        ]

        let result = topPhotoRefs(footprints, limit: 10)

        XCTAssertEqual(result.map(\.id), ["pB1", "pC1", "pC2", "pC3", "pA1", "pA2"])
    }

    /// `limit` 必须能在一段足迹内部"腰斩"——不是按足迹整段取舍，验证内存上界真正硬性生效。
    func testTopPhotoRefsStopsExactlyAtLimitEvenMidFootprint() {
        let day1 = Date(timeIntervalSince1970: 0)
        let day2 = Date(timeIntervalSince1970: 86400)
        let day3 = Date(timeIntervalSince1970: 172800)
        let footprints = [
            sampleFootprint(id: "A", date: day1, photoIds: ["pA1", "pA2"]),
            sampleFootprint(id: "B", date: day3, photoIds: ["pB1"]),
            sampleFootprint(id: "C", date: day2, photoIds: ["pC1", "pC2", "pC3"]),
        ]

        let result = topPhotoRefs(footprints, limit: 4)

        XCTAssertEqual(result.map(\.id), ["pB1", "pC1", "pC2", "pC3"])
    }

    func testTopPhotoRefsNoPhotosProducesEmptyResult() {
        let footprint = sampleFootprint(id: "A", date: Date(), photoIds: [])
        XCTAssertTrue(topPhotoRefs([footprint], limit: 9).isEmpty)
    }

    // MARK: - downloadAllSkippingFailures

    private func tinyImage() -> UIImage {
        UIGraphicsImageRenderer(size: CGSize(width: 1, height: 1)).image { _ in }
    }

    /// 单张失败（`download` 返回 nil）必须直接跳过、不中断后续，且不影响已成功的张数与顺序——
    /// 这是"单张照片下载失败不阻塞整体装配"契约的可单测部分（真实网络请求本身走手动模拟器核验）。
    func testDownloadAllSkippingFailuresSkipsFailuresPreservingOrder() async {
        let imageA = tinyImage()
        let imageC = tinyImage()

        let result = await downloadAllSkippingFailures(["a", "b", "c"]) { id in
            switch id {
            case "a": return imageA
            case "c": return imageC
            default: return nil // 模拟 "b" 这一张下载失败
            }
        }

        XCTAssertEqual(result.count, 2, "失败的一张应被跳过，不计入结果")
        XCTAssertTrue(result[0] === imageA)
        XCTAssertTrue(result[1] === imageC, "剩余成功项应保持原有相对顺序")
    }

    func testDownloadAllSkippingFailuresAllFailProducesEmptyResult() async {
        let result = await downloadAllSkippingFailures(["a", "b"]) { _ in nil }
        XCTAssertTrue(result.isEmpty)
    }

    // MARK: - TripShareCard.columns(forPhotoCount:)

    func testPhotoGridColumnsThreeTierSplit() {
        XCTAssertEqual(TripShareCard.columns(forPhotoCount: 0), 1)
        XCTAssertEqual(TripShareCard.columns(forPhotoCount: 1), 1)
        XCTAssertEqual(TripShareCard.columns(forPhotoCount: 2), 2)
        XCTAssertEqual(TripShareCard.columns(forPhotoCount: 4), 2)
        XCTAssertEqual(TripShareCard.columns(forPhotoCount: 5), 3)
        XCTAssertEqual(TripShareCard.columns(forPhotoCount: 9), 3)
    }
}
