import XCTest
@testable import LoongSuitePilotMenuBarApp

final class MetricsSnapshotTests: XCTestCase {

    // MARK: - Snapshot computed properties

    func testFormattedTotalTokens() {
        var snapshot = PilotMetricsSnapshot.makeEmpty(range: .today)
        snapshot.totalTokens = 48_534_323
        XCTAssertEqual(snapshot.formattedTotalTokens, "48.5M")
    }

    func testFormattedCacheReadShare_withData() {
        var snapshot = PilotMetricsSnapshot.makeEmpty(range: .today)
        snapshot.inputTokens = 100_000
        snapshot.cacheReadTokens = 85_000
        XCTAssertEqual(snapshot.formattedCacheReadShare, "85%")
    }

    func testFormattedCacheReadShare_zeroInput() {
        let snapshot = PilotMetricsSnapshot.makeEmpty(range: .today)
        XCTAssertEqual(snapshot.formattedCacheReadShare, "0%")
    }

    func testMenuBarTitle() {
        var snapshot = PilotMetricsSnapshot.makeEmpty(range: .today)
        snapshot.totalTokens = 8_523_400
        XCTAssertEqual(snapshot.menuBarTitle, "8.5M")
    }

    func testMenuBarTitle_zero() {
        let snapshot = PilotMetricsSnapshot.makeEmpty(range: .today)
        XCTAssertEqual(snapshot.menuBarTitle, "0")
    }

    func testMakeEmpty_hasEmptyModelShares() {
        let snapshot = PilotMetricsSnapshot.makeEmpty(range: .today)
        XCTAssertTrue(snapshot.modelShares.isEmpty)
    }

    // MARK: - AgentStatusItem

    func testAgentStatusItem_formattedTokens() {
        let item = AgentStatusItem(agentType: "claude-code", events: 415, tokens: 6_200_000, sessions: 3, share: 0.4)
        XCTAssertEqual(item.formattedTokens, "6.2M")
    }

    // MARK: - ProviderShareItem

    func testProviderShareItem_formattedShare() {
        let item = ProviderShareItem(provider: "anthropic", tokens: 6_200_000, share: 0.73)
        XCTAssertEqual(item.formattedShare, "73%")
        XCTAssertEqual(item.formattedTokens, "6.2M")
    }

    // MARK: - ModelShareItem

    func testModelShareItem_formattedShare() {
        let item = ModelShareItem(model: "claude-opus-4-7", tokens: 7_300_000, share: 0.73)
        XCTAssertEqual(item.formattedShare, "73%")
        XCTAssertEqual(item.formattedTokens, "7.3M")
        XCTAssertEqual(item.id, "claude-opus-4-7")
    }

    func testModelShareItem_smallTokens() {
        let item = ModelShareItem(model: "claude-haiku-4-5", tokens: 850, share: 0.0085)
        XCTAssertEqual(item.formattedShare, "1%")
        XCTAssertEqual(item.formattedTokens, "850")
    }

    // MARK: - buildSnapshot decodes modelShares

    @MainActor
    func testBuildSnapshot_decodesModelSharesInOrder() throws {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("metrics-\(UUID().uuidString)")
        try FileManager.default.createDirectory(
            at: tempDir.appendingPathComponent("logs"),
            withIntermediateDirectories: true
        )
        defer { try? FileManager.default.removeItem(at: tempDir) }

        // fixture source: modeled on tests/unit/status-bar/metrics-summary-writer.test.ts
        // existing claude-opus-4-6 / claude-sonnet-4-6 modelShares structure
        let json = #"""
        {"version":1,"ranges":{"today":{"totalTokens":10000000,
          "modelShares":[
            {"model":"claude-opus-4-7","totalTokens":7300000,"inputTokens":5000000,"cacheReadTokens":2000000,"share":0.73},
            {"model":"claude-sonnet-4-6","totalTokens":2700000,"inputTokens":1800000,"cacheReadTokens":400000,"share":0.27}
          ]}}}
        """#.data(using: .utf8)!
        try json.write(to: tempDir.appendingPathComponent("logs/metrics-summary.json"))

        setenv("LOONGSUITE_PILOT_DATA_DIR", tempDir.path, 1)
        defer { unsetenv("LOONGSUITE_PILOT_DATA_DIR") }

        let store = PilotMetricsStore()
        store.refresh()

        let expectation = XCTestExpectation(description: "snapshot loaded from temp file")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { expectation.fulfill() }
        wait(for: [expectation], timeout: 2.0)

        XCTAssertEqual(store.snapshot.totalTokens, 10_000_000)
        XCTAssertEqual(store.snapshot.modelShares.count, 2)
        XCTAssertEqual(store.snapshot.modelShares[0].model, "claude-opus-4-7")
        XCTAssertEqual(store.snapshot.modelShares[0].tokens, 7_300_000)
        XCTAssertEqual(store.snapshot.modelShares[0].share, 0.73, accuracy: 0.0001)
        XCTAssertEqual(store.snapshot.modelShares[0].formattedShare, "73%")
        XCTAssertEqual(store.snapshot.modelShares[0].formattedTokens, "7.3M")
        XCTAssertEqual(store.snapshot.modelShares[1].model, "claude-sonnet-4-6")
        XCTAssertEqual(store.snapshot.modelShares[1].tokens, 2_700_000)
        XCTAssertEqual(store.snapshot.modelShares[1].share, 0.27, accuracy: 0.0001)
        XCTAssertEqual(store.snapshot.modelShares[1].formattedShare, "27%")
        XCTAssertEqual(store.snapshot.modelShares[1].formattedTokens, "2.7M")
    }

    @MainActor
    func testBuildSnapshot_modelSharesMissing_yieldsEmptyArray() throws {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("metrics-\(UUID().uuidString)")
        try FileManager.default.createDirectory(
            at: tempDir.appendingPathComponent("logs"),
            withIntermediateDirectories: true
        )
        defer { try? FileManager.default.removeItem(at: tempDir) }

        // old metrics-summary.json without a modelShares field — backward compatibility
        let json = #"""
        {"version":1,"ranges":{"today":{"totalTokens":1000}}}
        """#.data(using: .utf8)!
        try json.write(to: tempDir.appendingPathComponent("logs/metrics-summary.json"))

        setenv("LOONGSUITE_PILOT_DATA_DIR", tempDir.path, 1)
        defer { unsetenv("LOONGSUITE_PILOT_DATA_DIR") }

        let store = PilotMetricsStore()
        store.refresh()

        let expectation = XCTestExpectation(description: "snapshot loaded without modelShares")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { expectation.fulfill() }
        wait(for: [expectation], timeout: 2.0)

        XCTAssertEqual(store.snapshot.totalTokens, 1000)
        XCTAssertTrue(store.snapshot.modelShares.isEmpty)
    }

    // MARK: - MetricsAggregationRange

    func testRangePickerTitles() {
        XCTAssertEqual(MetricsAggregationRange.today.pickerTitle, "Today")
        XCTAssertEqual(MetricsAggregationRange.sevenDays.pickerTitle, "7D")
        XCTAssertEqual(MetricsAggregationRange.thirtyDays.pickerTitle, "30D")
    }

    func testRangeTrendRange() {
        XCTAssertEqual(MetricsAggregationRange.today.trendRange, .sevenDays)
        XCTAssertEqual(MetricsAggregationRange.sevenDays.trendRange, .sevenDays)
        XCTAssertEqual(MetricsAggregationRange.thirtyDays.trendRange, .thirtyDays)
    }

    // MARK: - #3 ModelShareItem share extremes / progress bar width safety
    // Mirrors PanelContentView.swift modelsSection: `max(4, geo.size.width * item.share)`
    // Safety contract: bar width must be finite, falling back to the minimum 4 or clamped to totalWidth, so SwiftUI never crashes on NaN/out-of-range widths.

    /// Pure re-computation of `max(4, geo.size.width * item.share)` from PanelContentView, to verify the safety contract in tests.
    private func progressBarWidth(share: Double, totalWidth: Double) -> Double {
        return max(4.0, totalWidth * share)
    }

    func testModelShareItem_zeroShare_progressWidthFloorsAtFour() {
        let item = ModelShareItem(model: "claude-haiku-4-5", tokens: 0, share: 0)
        let width = progressBarWidth(share: item.share, totalWidth: 240)
        XCTAssertEqual(width, 4.0, "with share=0 the bar should fall back to the minimum width 4")
        XCTAssertTrue(width.isFinite)
    }

    func testModelShareItem_shareGreaterThanOne_progressWidthClampedToTotalWidth() {
        // share>1 can happen when totalTokens resets or upstream aggregation misbehaves.
        // Safety contract: width must not exceed the container width, otherwise the bar overflows the GeometryReader.
        let item = ModelShareItem(model: "anomaly-model", tokens: 999, share: 1.5)
        let totalWidth = 240.0
        let width = progressBarWidth(share: item.share, totalWidth: totalWidth)
        XCTAssertTrue(width.isFinite, "with share=1.5 the width must be finite")
        XCTAssertLessThanOrEqual(
            width, totalWidth,
            "with share>1 the bar width should be clamped to totalWidth=\(totalWidth), actual width=\(width)"
        )
    }

    func testModelShareItem_nanShare_progressWidthIsFinite() {
        // share=NaN can appear on edge cases such as division by zero (totalTokens=0).
        // Safety contract: width must be finite, otherwise SwiftUI .frame(width: NaN) crashes.
        let item = ModelShareItem(model: "nan-model", tokens: 0, share: .nan)
        let width = progressBarWidth(share: item.share, totalWidth: 240)
        XCTAssertEqual(item.share, 0, "ModelShareItem should clamp NaN to 0 in init")
        XCTAssertFalse(width.isNaN, "with share=NaN the bar width must not become NaN (SwiftUI would crash), actual width=\(width)")
        XCTAssertTrue(width.isFinite, "with share=NaN the width must be finite, actual width=\(width)")
    }

    // MARK: - #4 metrics-summary.json per-field null values

    @MainActor
    func testBuildSnapshot_modelShareEntry_nullModel_fallsBackToUnknown() throws {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("metrics-\(UUID().uuidString)")
        try FileManager.default.createDirectory(
            at: tempDir.appendingPathComponent("logs"),
            withIntermediateDirectories: true
        )
        defer { try? FileManager.default.removeItem(at: tempDir) }

        let json = #"""
        {"version":1,"ranges":{"today":{"totalTokens":1000,
          "modelShares":[
            {"model":null,"totalTokens":600,"share":0.6},
            {"model":"claude-opus-4-7","totalTokens":400,"share":0.4}
          ]}}}
        """#.data(using: .utf8)!
        try json.write(to: tempDir.appendingPathComponent("logs/metrics-summary.json"))

        setenv("LOONGSUITE_PILOT_DATA_DIR", tempDir.path, 1)
        defer { unsetenv("LOONGSUITE_PILOT_DATA_DIR") }

        let store = PilotMetricsStore()
        store.refresh()

        let expectation = XCTestExpectation(description: "snapshot loaded with null model")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { expectation.fulfill() }
        wait(for: [expectation], timeout: 2.0)

        XCTAssertEqual(store.snapshot.modelShares.count, 2, "a null model entry should be kept with defaults, not swallowed")
        XCTAssertEqual(store.snapshot.modelShares[0].model, "unknown", "model=null should fall back to unknown")
        XCTAssertEqual(store.snapshot.modelShares[0].tokens, 600)
        XCTAssertEqual(store.snapshot.modelShares[1].model, "claude-opus-4-7")
    }

    @MainActor
    func testBuildSnapshot_modelShareEntry_nullTotalTokens_fallsBackToZero() throws {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("metrics-\(UUID().uuidString)")
        try FileManager.default.createDirectory(
            at: tempDir.appendingPathComponent("logs"),
            withIntermediateDirectories: true
        )
        defer { try? FileManager.default.removeItem(at: tempDir) }

        let json = #"""
        {"version":1,"ranges":{"today":{"totalTokens":1000,
          "modelShares":[
            {"model":"claude-opus-4-7","totalTokens":null,"share":0.5},
            {"model":"claude-sonnet-4-6","totalTokens":500,"share":0.5}
          ]}}}
        """#.data(using: .utf8)!
        try json.write(to: tempDir.appendingPathComponent("logs/metrics-summary.json"))

        setenv("LOONGSUITE_PILOT_DATA_DIR", tempDir.path, 1)
        defer { unsetenv("LOONGSUITE_PILOT_DATA_DIR") }

        let store = PilotMetricsStore()
        store.refresh()

        let expectation = XCTestExpectation(description: "snapshot loaded with null totalTokens")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { expectation.fulfill() }
        wait(for: [expectation], timeout: 2.0)

        XCTAssertEqual(store.snapshot.modelShares.count, 2)
        XCTAssertEqual(store.snapshot.modelShares[0].model, "claude-opus-4-7")
        XCTAssertEqual(store.snapshot.modelShares[0].tokens, 0, "totalTokens=null should fall back to 0")
        XCTAssertEqual(store.snapshot.modelShares[0].formattedTokens, "0")
        XCTAssertEqual(store.snapshot.modelShares[1].tokens, 500)
    }

    @MainActor
    func testBuildSnapshot_modelShareEntry_nullShare_fallsBackToZero() throws {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("metrics-\(UUID().uuidString)")
        try FileManager.default.createDirectory(
            at: tempDir.appendingPathComponent("logs"),
            withIntermediateDirectories: true
        )
        defer { try? FileManager.default.removeItem(at: tempDir) }

        let json = #"""
        {"version":1,"ranges":{"today":{"totalTokens":1000,
          "modelShares":[
            {"model":"claude-opus-4-7","totalTokens":700,"share":null},
            {"model":"claude-sonnet-4-6","totalTokens":300,"share":0.3}
          ]}}}
        """#.data(using: .utf8)!
        try json.write(to: tempDir.appendingPathComponent("logs/metrics-summary.json"))

        setenv("LOONGSUITE_PILOT_DATA_DIR", tempDir.path, 1)
        defer { unsetenv("LOONGSUITE_PILOT_DATA_DIR") }

        let store = PilotMetricsStore()
        store.refresh()

        let expectation = XCTestExpectation(description: "snapshot loaded with null share")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { expectation.fulfill() }
        wait(for: [expectation], timeout: 2.0)

        XCTAssertEqual(store.snapshot.modelShares.count, 2)
        XCTAssertEqual(store.snapshot.modelShares[0].model, "claude-opus-4-7")
        XCTAssertEqual(store.snapshot.modelShares[0].share, 0, "share=null should fall back to 0")
        XCTAssertEqual(store.snapshot.modelShares[0].formattedShare, "0%")
        XCTAssertEqual(store.snapshot.modelShares[1].share, 0.3, accuracy: 0.0001)
    }

    @MainActor
    func testBuildSnapshot_modelShareEntry_allFieldsNull_fallsBackToDefaults() throws {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("metrics-\(UUID().uuidString)")
        try FileManager.default.createDirectory(
            at: tempDir.appendingPathComponent("logs"),
            withIntermediateDirectories: true
        )
        defer { try? FileManager.default.removeItem(at: tempDir) }

        let json = #"""
        {"version":1,"ranges":{"today":{"totalTokens":1000,
          "modelShares":[
            {"model":null,"totalTokens":null,"share":null}
          ]}}}
        """#.data(using: .utf8)!
        try json.write(to: tempDir.appendingPathComponent("logs/metrics-summary.json"))

        setenv("LOONGSUITE_PILOT_DATA_DIR", tempDir.path, 1)
        defer { unsetenv("LOONGSUITE_PILOT_DATA_DIR") }

        let store = PilotMetricsStore()
        store.refresh()

        let expectation = XCTestExpectation(description: "snapshot loaded with all-null model entry")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { expectation.fulfill() }
        wait(for: [expectation], timeout: 2.0)

        XCTAssertEqual(store.snapshot.modelShares.count, 1, "an all-empty entry should still be kept; the UI decides how to show it")
        XCTAssertEqual(store.snapshot.modelShares[0].model, "unknown")
        XCTAssertEqual(store.snapshot.modelShares[0].tokens, 0)
        XCTAssertEqual(store.snapshot.modelShares[0].share, 0)
    }

    // MARK: - #5 the whole metrics-summary.json is malformed JSON

    @MainActor
    func testBuildSnapshot_malformedJSON_returnsEmptySnapshotWithError() throws {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("metrics-\(UUID().uuidString)")
        try FileManager.default.createDirectory(
            at: tempDir.appendingPathComponent("logs"),
            withIntermediateDirectories: true
        )
        defer { try? FileManager.default.removeItem(at: tempDir) }

        // Truncated JSON: missing closing brace, JSONDecoder must fail
        let malformed = #"""
        {"version":1,"ranges":{"today":{"totalTokens":1000,"modelShares":[
        """#.data(using: .utf8)!
        try malformed.write(to: tempDir.appendingPathComponent("logs/metrics-summary.json"))

        setenv("LOONGSUITE_PILOT_DATA_DIR", tempDir.path, 1)
        defer { unsetenv("LOONGSUITE_PILOT_DATA_DIR") }

        let store = PilotMetricsStore()
        store.refresh()

        let expectation = XCTestExpectation(description: "snapshot fell back after malformed JSON")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { expectation.fulfill() }
        wait(for: [expectation], timeout: 2.0)

        // Safety contract: malformed → loadFile returns nil → buildSnapshot takes the empty + errorMessage branch, no crash
        XCTAssertEqual(store.snapshot.totalTokens, 0, "malformed JSON should fall back to an empty snapshot with 0 tokens")
        XCTAssertTrue(store.snapshot.modelShares.isEmpty, "malformed JSON should leave no modelShares behind")
        XCTAssertTrue(store.snapshot.agentStats.isEmpty)
        XCTAssertTrue(store.snapshot.providerShares.isEmpty)
        XCTAssertNotNil(store.snapshot.errorMessage, "malformed/missing file should set errorMessage to notify the user")
    }

    @MainActor
    func testBuildSnapshot_garbageJSON_returnsEmptySnapshotWithError() throws {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("metrics-\(UUID().uuidString)")
        try FileManager.default.createDirectory(
            at: tempDir.appendingPathComponent("logs"),
            withIntermediateDirectories: true
        )
        defer { try? FileManager.default.removeItem(at: tempDir) }

        // Text that is not JSON at all
        let garbage = "this is not json at all garbled non-ASCII text \u{0000}\u{FFFE}".data(using: .utf8)!
        try garbage.write(to: tempDir.appendingPathComponent("logs/metrics-summary.json"))

        setenv("LOONGSUITE_PILOT_DATA_DIR", tempDir.path, 1)
        defer { unsetenv("LOONGSUITE_PILOT_DATA_DIR") }

        let store = PilotMetricsStore()
        store.refresh()

        let expectation = XCTestExpectation(description: "snapshot fell back after garbage JSON")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { expectation.fulfill() }
        wait(for: [expectation], timeout: 2.0)

        XCTAssertEqual(store.snapshot.totalTokens, 0)
        XCTAssertTrue(store.snapshot.modelShares.isEmpty)
        XCTAssertNotNil(store.snapshot.errorMessage)
    }
}
