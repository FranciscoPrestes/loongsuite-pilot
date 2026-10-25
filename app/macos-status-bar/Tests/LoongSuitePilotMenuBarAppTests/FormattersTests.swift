import XCTest
@testable import LoongSuitePilotMenuBarApp

final class FormattersTests: XCTestCase {

    // MARK: - releaseLabel (releases do fork se chamam NT-TES <n>)

    func testReleaseLabel_ntcRelease() {
        XCTAssertEqual(Formatters.releaseLabel("1.2.0-ntc.13-local-model-effort"), "NT-TES 13")
        XCTAssertEqual(Formatters.releaseLabel("1.2.0-ntc.13"), "NT-TES 13")
        XCTAssertEqual(Formatters.releaseLabel("v1.3.1-ntc.7"), "NT-TES 7")
    }

    func testReleaseLabel_semNumeracaoNtcMantemVersao() {
        XCTAssertEqual(Formatters.releaseLabel("1.1.3"), "v1.1.3")
        XCTAssertEqual(Formatters.releaseLabel(nil), "v--")
        XCTAssertEqual(Formatters.releaseLabel("  "), "v--")
    }

    // MARK: - compactNumber

    func testCompactNumber_millions() {
        XCTAssertEqual(Formatters.compactNumber(48_534_323), "48.5M")
        XCTAssertEqual(Formatters.compactNumber(1_000_000), "1.0M")
        XCTAssertEqual(Formatters.compactNumber(1_500_000), "1.5M")
        XCTAssertEqual(Formatters.compactNumber(123_456_789), "123.5M")
    }

    func testCompactNumber_thousands() {
        XCTAssertEqual(Formatters.compactNumber(1_000), "1.0K")
        XCTAssertEqual(Formatters.compactNumber(1_500), "1.5K")
        XCTAssertEqual(Formatters.compactNumber(999_999), "1000.0K")
        XCTAssertEqual(Formatters.compactNumber(523_400), "523.4K")
    }

    func testCompactNumber_small() {
        XCTAssertEqual(Formatters.compactNumber(0), "0")
        XCTAssertEqual(Formatters.compactNumber(1), "1")
        XCTAssertEqual(Formatters.compactNumber(999), "999")
    }

    // MARK: - percent

    func testPercent_basic() {
        XCTAssertEqual(Formatters.percent(0.0), "0%")
        XCTAssertEqual(Formatters.percent(1.0), "100%")
        XCTAssertEqual(Formatters.percent(0.73), "73%")
        XCTAssertEqual(Formatters.percent(0.5), "50%")
    }

    func testPercent_rounding() {
        XCTAssertEqual(Formatters.percent(0.976), "98%")
        XCTAssertEqual(Formatters.percent(0.004), "0%")
        XCTAssertEqual(Formatters.percent(0.005), "1%")
    }
}
