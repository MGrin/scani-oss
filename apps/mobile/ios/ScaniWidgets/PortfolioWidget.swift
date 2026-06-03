import SwiftUI
import WidgetKit

struct PortfolioEntry: TimelineEntry {
    let date: Date
    let portfolioTotal: String
}

struct PortfolioProvider: TimelineProvider {
    func placeholder(in context: Context) -> PortfolioEntry {
        PortfolioEntry(date: .now, portfolioTotal: "—")
    }

    func getSnapshot(in context: Context, completion: @escaping (PortfolioEntry) -> Void) {
        let total = loadWidgetData()?.portfolioTotal ?? "—"
        completion(PortfolioEntry(date: .now, portfolioTotal: total))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<PortfolioEntry>) -> Void) {
        let total = loadWidgetData()?.portfolioTotal ?? "—"
        let entry = PortfolioEntry(date: .now, portfolioTotal: total)
        completion(Timeline(entries: [entry], policy: .never))
    }
}

struct PortfolioWidgetView: View {
    let entry: PortfolioEntry
    @Environment(\.widgetFamily) private var family

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Portfolio")
                .font(.caption)
                .foregroundStyle(.secondary)
            Spacer()
            Text(entry.portfolioTotal == "—" ? "Open Scani" : entry.portfolioTotal)
                .font(family == .systemSmall ? .title2 : .title)
                .fontWeight(.semibold)
                .minimumScaleFactor(0.7)
                .lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding()
    }
}

struct PortfolioWidget: Widget {
    let kind = "PortfolioWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: PortfolioProvider()) { entry in
            PortfolioWidgetView(entry: entry)
        }
        .configurationDisplayName("Portfolio")
        .description("Your total portfolio value at a glance.")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}
