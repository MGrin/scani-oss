import Foundation

struct WidgetEntity: Codable {
    let id: String
    let name: String
    let value: String
}

struct WidgetData: Codable {
    let portfolioTotal: String
    let accounts: [WidgetEntity]
    let holdings: [WidgetEntity]
    let groups: [WidgetEntity]
    let vaults: [WidgetEntity]
    let updatedAt: Int64
}

func loadWidgetData() -> WidgetData? {
    guard
        let url = FileManager.default
            .containerURL(forSecurityApplicationGroupIdentifier: "group.xyz.scani.mobile")?
            .appendingPathComponent("widget.json"),
        let data = try? Data(contentsOf: url)
    else { return nil }
    return try? JSONDecoder().decode(WidgetData.self, from: data)
}
