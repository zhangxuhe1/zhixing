import SwiftUI

/// 我的 · 旅程小结：两段独立 LoadState——「建议的旅程」（GET /me/trip-suggestions，服务端划界算法
/// 现算不落库，`TripSuggestion.id` 由 footprintIds 拼接合成、随重分段变化，不得持久化）与
/// 「已保存」（GET /me/trips，服务端已按 startDate 倒序）。两段都成功加载且都为空时，才折叠成
/// 唯一的整体空态；否则各自按 LoadState 展示（含独立失败重试）。
struct TripsScreen: View {
    @Environment(FootprintStore.self) private var footprints
    @State private var suggestionsState: LoadState<[TripSuggestion]> = .idle
    @State private var tripsState: LoadState<[Trip]> = .idle
    @State private var creatingSuggestion: TripSuggestion?
    @State private var editingTrip: Trip?

    private var isFullyEmpty: Bool {
        guard case let .loaded(suggestions) = suggestionsState, case let .loaded(trips) = tripsState
        else { return false }
        return suggestions.isEmpty && trips.isEmpty
    }

    var body: some View {
        Group {
            if isFullyEmpty {
                emptyState
            } else {
                List {
                    Section("建议的旅程") {
                        LoadStateView(state: suggestionsState, retry: { Task { await loadSuggestions() } }) { suggestions in
                            ForEach(suggestions) { suggestion in
                                Button {
                                    creatingSuggestion = suggestion
                                } label: {
                                    TripSummaryContent(
                                        title: suggestion.suggestedTitle,
                                        dateRange: tripDateRange(suggestion.startDate, suggestion.endDate),
                                        footprintCount: suggestion.footprintIds.count)
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }
                    Section("已保存") {
                        LoadStateView(state: tripsState, retry: { Task { await loadTrips() } }) { trips in
                            ForEach(trips) { trip in
                                savedTripRow(trip)
                            }
                        }
                    }
                }
            }
        }
        .navigationTitle("旅程小结")
        .navigationBarTitleDisplayMode(.inline)
        .sheet(item: $creatingSuggestion) { suggestion in
            TripEditScreen(mode: .create(suggestion), onSaved: handleSaved)
        }
        .sheet(item: $editingTrip) { trip in
            TripEditScreen(mode: .edit(trip), onSaved: handleSaved)
        }
        .task { await reloadAll() }
    }

    /// 已保存旅程行：不整行包 Button——行内还要放一个（当前禁用的）「分享」按钮，两个 Button 嵌套
    /// 在 List 行里会互相抢手势，改用 StoriesSection.StoryRow 的既有解法：整行只挂 onTapGesture
    /// 负责“打开编辑”，「分享」用真正独立的 .buttonStyle(.plain) Button 承担二级操作。
    @ViewBuilder
    private func savedTripRow(_ trip: Trip) -> some View {
        HStack {
            TripSummaryContent(
                title: trip.title,
                dateRange: tripDateRange(trip.startDate, trip.endDate),
                footprintCount: trip.footprintCount)
            Spacer()
            Button {
                // I8 占位：分享长图入口尚未实装，本任务先禁用，避免误触发不存在的流程。
            } label: {
                Image(systemName: "square.and.arrow.up")
            }
            .buttonStyle(.plain)
            .disabled(true)
            .accessibilityLabel("分享（即将上线）")
        }
        .contentShape(Rectangle())
        .onTapGesture { editingTrip = trip }
    }

    private var emptyState: some View {
        Text("留下带日期的足迹后，这里会自动整理出你的旅程")
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.center)
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 32)
            .padding(.vertical, 24)
    }

    /// 保存/删除成功后的统一收口：两段列表 + FootprintStore 都要重新拉取（tripId 分布变了）。
    private func handleSaved() async {
        await reloadAll()
        await footprints.load()
    }

    private func reloadAll() async {
        await loadSuggestions()
        await loadTrips()
    }

    private func loadSuggestions() async {
        suggestionsState = .loading
        do {
            let page: TripSuggestionsResponse = try await APIClient.shared.get("/me/trip-suggestions")
            suggestionsState = .loaded(page.suggestions)
        } catch {
            suggestionsState = .failed("旅程建议加载失败，请重试")
        }
    }

    private func loadTrips() async {
        tripsState = .loading
        do {
            let page: TripsListResponse = try await APIClient.shared.get("/me/trips")
            tripsState = .loaded(page.items)
        } catch {
            tripsState = .failed("已保存的旅程加载失败，请重试")
        }
    }
}

private struct TripSuggestionsResponse: Decodable { let suggestions: [TripSuggestion] }
private struct TripsListResponse: Decodable { let items: [Trip] }

private struct TripSummaryContent: View {
    let title: String
    let dateRange: String
    let footprintCount: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.headline)
            Text("\(dateRange) · \(footprintCount) 段足迹")
                .font(.caption).foregroundStyle(.secondary)
        }
        .padding(.vertical, 4)
    }
}

/// CST（+08:00，无夏令时）固定偏移日历——与服务端 `time.ts` 的 `cstParts`（UTC 毫秒加 8 小时偏移后
/// 读 UTC 字段）同一语义，用 `TimeZone(secondsFromGMT:)` 而非命名时区（如 "Asia/Shanghai"）实现，
/// 不经系统时区数据库，产线与测试表现完全一致、不随设备/宿主机时区设置抖动。
private let cstCalendar: Calendar = {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(secondsFromGMT: 8 * 3600)!
    return calendar
}()

/// 旅程日期范围展示：同一 CST 日历日不出现分隔符（「2024年5月1日」）；同年同月省略月份重复
/// （「2024年5月1日–4日」）；同年跨月省略年份重复（「2024年5月30日–6月2日」）；跨年两端各自
/// 完整（「2024年12月30日–2025年1月2日」）。分隔符用 en dash "–"，与产品文案原文字符一致。
func tripDateRange(_ start: Date, _ end: Date) -> String {
    let s = cstCalendar.dateComponents([.year, .month, .day], from: start)
    let e = cstCalendar.dateComponents([.year, .month, .day], from: end)
    guard let sy = s.year, let sm = s.month, let sd = s.day,
          let ey = e.year, let em = e.month, let ed = e.day
    else { return "" }

    if sy == ey, sm == em, sd == ed {
        return "\(sy)年\(sm)月\(sd)日"
    }
    if sy == ey, sm == em {
        return "\(sy)年\(sm)月\(sd)日–\(ed)日"
    }
    if sy == ey {
        return "\(sy)年\(sm)月\(sd)日–\(em)月\(ed)日"
    }
    return "\(sy)年\(sm)月\(sd)日–\(ey)年\(em)月\(ed)日"
}
