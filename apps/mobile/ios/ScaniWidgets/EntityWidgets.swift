import SwiftUI
import WidgetKit

@available(iOS 17.0, *)
struct EntityEntry: TimelineEntry {
    let date: Date
    let label: String
    let name: String
    let value: String
}

@available(iOS 17.0, *)
private func makeEntry(label: String, entity: WidgetEntityAppEntity?, fallbackName: String) -> EntityEntry {
    guard let entity else {
        return EntityEntry(date: .now, label: label, name: "Tap to configure", value: "")
    }
    return EntityEntry(date: .now, label: label, name: entity.name, value: entity.value)
}

@available(iOS 17.0, *)
struct EntityWidgetView: View {
    let entry: EntityEntry
    @Environment(\.widgetFamily) private var family

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(entry.label)
                .font(.caption)
                .foregroundStyle(.secondary)
            Spacer()
            Text(entry.name)
                .font(.headline)
                .minimumScaleFactor(0.7)
                .lineLimit(2)
            if !entry.value.isEmpty {
                Text(entry.value)
                    .font(family == .systemSmall ? .title2 : .title)
                    .fontWeight(.semibold)
                    .minimumScaleFactor(0.7)
                    .lineLimit(1)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding()
    }
}

// MARK: - Account

@available(iOS 17.0, *)
struct AccountProvider: AppIntentTimelineProvider {
    func placeholder(in context: Context) -> EntityEntry {
        EntityEntry(date: .now, label: "Account", name: "My Account", value: "$1,234")
    }

    func snapshot(for configuration: SelectAccountIntent, in context: Context) async -> EntityEntry {
        makeEntry(label: "Account", entity: configuration.entity, fallbackName: "Account")
    }

    func timeline(for configuration: SelectAccountIntent, in context: Context) async -> Timeline<EntityEntry> {
        let entry = makeEntry(label: "Account", entity: configuration.entity, fallbackName: "Account")
        return Timeline(entries: [entry], policy: .never)
    }
}

@available(iOS 17.0, *)
struct AccountWidget: Widget {
    let kind = "AccountWidget"

    var body: some WidgetConfiguration {
        AppIntentConfiguration(kind: kind, intent: SelectAccountIntent.self, provider: AccountProvider()) { entry in
            EntityWidgetView(entry: entry)
        }
        .configurationDisplayName("Account")
        .description("Track the value of a single account.")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}

// MARK: - Holding

@available(iOS 17.0, *)
struct HoldingProvider: AppIntentTimelineProvider {
    func placeholder(in context: Context) -> EntityEntry {
        EntityEntry(date: .now, label: "Holding", name: "BTC", value: "$42,000")
    }

    func snapshot(for configuration: SelectHoldingIntent, in context: Context) async -> EntityEntry {
        makeEntry(label: "Holding", entity: configuration.entity, fallbackName: "Holding")
    }

    func timeline(for configuration: SelectHoldingIntent, in context: Context) async -> Timeline<EntityEntry> {
        let entry = makeEntry(label: "Holding", entity: configuration.entity, fallbackName: "Holding")
        return Timeline(entries: [entry], policy: .never)
    }
}

@available(iOS 17.0, *)
struct HoldingWidget: Widget {
    let kind = "HoldingWidget"

    var body: some WidgetConfiguration {
        AppIntentConfiguration(kind: kind, intent: SelectHoldingIntent.self, provider: HoldingProvider()) { entry in
            EntityWidgetView(entry: entry)
        }
        .configurationDisplayName("Holding")
        .description("Track the value of a single holding.")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}

// MARK: - Group

@available(iOS 17.0, *)
struct GroupProvider: AppIntentTimelineProvider {
    func placeholder(in context: Context) -> EntityEntry {
        EntityEntry(date: .now, label: "Group", name: "Crypto", value: "$10,000")
    }

    func snapshot(for configuration: SelectGroupIntent, in context: Context) async -> EntityEntry {
        makeEntry(label: "Group", entity: configuration.entity, fallbackName: "Group")
    }

    func timeline(for configuration: SelectGroupIntent, in context: Context) async -> Timeline<EntityEntry> {
        let entry = makeEntry(label: "Group", entity: configuration.entity, fallbackName: "Group")
        return Timeline(entries: [entry], policy: .never)
    }
}

@available(iOS 17.0, *)
struct GroupWidget: Widget {
    let kind = "GroupWidget"

    var body: some WidgetConfiguration {
        AppIntentConfiguration(kind: kind, intent: SelectGroupIntent.self, provider: GroupProvider()) { entry in
            EntityWidgetView(entry: entry)
        }
        .configurationDisplayName("Group")
        .description("Track the value of a portfolio group.")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}

// MARK: - Vault

@available(iOS 17.0, *)
struct VaultProvider: AppIntentTimelineProvider {
    func placeholder(in context: Context) -> EntityEntry {
        EntityEntry(date: .now, label: "Vault", name: "Savings", value: "$5,000")
    }

    func snapshot(for configuration: SelectVaultIntent, in context: Context) async -> EntityEntry {
        makeEntry(label: "Vault", entity: configuration.entity, fallbackName: "Vault")
    }

    func timeline(for configuration: SelectVaultIntent, in context: Context) async -> Timeline<EntityEntry> {
        let entry = makeEntry(label: "Vault", entity: configuration.entity, fallbackName: "Vault")
        return Timeline(entries: [entry], policy: .never)
    }
}

@available(iOS 17.0, *)
struct VaultWidget: Widget {
    let kind = "VaultWidget"

    var body: some WidgetConfiguration {
        AppIntentConfiguration(kind: kind, intent: SelectVaultIntent.self, provider: VaultProvider()) { entry in
            EntityWidgetView(entry: entry)
        }
        .configurationDisplayName("Vault")
        .description("Track the value of a vault.")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}
