import Foundation

enum Formatters {
    /// Rótulo de release mostrado no painel: as releases do fork se chamam "NT-TES <n>" (sufixo `-ntc.<n>` da versão).
    /// Sem numeração ntc (build upstream ou local), mostra a versão técnica.
    static func releaseLabel(_ version: String?) -> String {
        let v = (version ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !v.isEmpty else { return "v--" }
        if let r = v.range(of: #"-ntc\.(\d+)"#, options: .regularExpression) {
            let numero = v[r].split(separator: ".").last.map(String.init) ?? ""
            if !numero.isEmpty { return "NT-TES \(numero)" }
        }
        return v.hasPrefix("v") ? v : "v\(v)"
    }

    static func compactNumber(_ value: Int) -> String {
        if value >= 1_000_000 {
            let millions = Double(value) / 1_000_000.0
            return String(format: "%.1fM", millions)
        }
        if value >= 1_000 {
            let thousands = Double(value) / 1_000.0
            return String(format: "%.1fK", thousands)
        }
        let formatter = NumberFormatter()
        formatter.numberStyle = .decimal
        return formatter.string(from: NSNumber(value: value)) ?? "\(value)"
    }

    static func percent(_ value: Double) -> String {
        "\(Int(round(value * 100)))%"
    }
}
