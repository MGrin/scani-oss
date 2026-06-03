import AppIntents
import WidgetKit

// AppIntentConfiguration + AppEntity require iOS 17.
@available(iOS 17.0, *)
struct WidgetEntityAppEntity: AppEntity {
    static var typeDisplayRepresentation: TypeDisplayRepresentation = "Entity"
    static var defaultQuery = WidgetEntityQuery()

    var id: String
    var name: String
    var value: String
    // kind discriminates which list this entity came from.
    var kind: EntityKind

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(name)", subtitle: "\(value)")
    }

    enum EntityKind: String, Codable, Sendable {
        case account, holding, group, vault
    }
}

@available(iOS 17.0, *)
struct WidgetEntityQuery: EntityQuery {
    func entities(for identifiers: [String]) async throws -> [WidgetEntityAppEntity] {
        allEntities().filter { identifiers.contains($0.id) }
    }

    func suggestedEntities() async throws -> [WidgetEntityAppEntity] {
        allEntities()
    }

    private func allEntities() -> [WidgetEntityAppEntity] {
        guard let data = loadWidgetData() else { return [] }
        return
            data.accounts.map { WidgetEntityAppEntity(id: $0.id, name: $0.name, value: $0.value, kind: .account) } +
            data.holdings.map { WidgetEntityAppEntity(id: $0.id, name: $0.name, value: $0.value, kind: .holding) } +
            data.groups.map { WidgetEntityAppEntity(id: $0.id, name: $0.name, value: $0.value, kind: .group) } +
            data.vaults.map { WidgetEntityAppEntity(id: $0.id, name: $0.name, value: $0.value, kind: .vault) }
    }
}

// Per-kind query types so each widget's gallery entry shows only relevant entities.
@available(iOS 17.0, *)
struct AccountEntityQuery: EntityQuery {
    func entities(for identifiers: [String]) async throws -> [WidgetEntityAppEntity] {
        (loadWidgetData()?.accounts ?? [])
            .filter { identifiers.contains($0.id) }
            .map { WidgetEntityAppEntity(id: $0.id, name: $0.name, value: $0.value, kind: .account) }
    }

    func suggestedEntities() async throws -> [WidgetEntityAppEntity] {
        (loadWidgetData()?.accounts ?? [])
            .map { WidgetEntityAppEntity(id: $0.id, name: $0.name, value: $0.value, kind: .account) }
    }
}

@available(iOS 17.0, *)
struct HoldingEntityQuery: EntityQuery {
    func entities(for identifiers: [String]) async throws -> [WidgetEntityAppEntity] {
        (loadWidgetData()?.holdings ?? [])
            .filter { identifiers.contains($0.id) }
            .map { WidgetEntityAppEntity(id: $0.id, name: $0.name, value: $0.value, kind: .holding) }
    }

    func suggestedEntities() async throws -> [WidgetEntityAppEntity] {
        (loadWidgetData()?.holdings ?? [])
            .map { WidgetEntityAppEntity(id: $0.id, name: $0.name, value: $0.value, kind: .holding) }
    }
}

@available(iOS 17.0, *)
struct GroupEntityQuery: EntityQuery {
    func entities(for identifiers: [String]) async throws -> [WidgetEntityAppEntity] {
        (loadWidgetData()?.groups ?? [])
            .filter { identifiers.contains($0.id) }
            .map { WidgetEntityAppEntity(id: $0.id, name: $0.name, value: $0.value, kind: .group) }
    }

    func suggestedEntities() async throws -> [WidgetEntityAppEntity] {
        (loadWidgetData()?.groups ?? [])
            .map { WidgetEntityAppEntity(id: $0.id, name: $0.name, value: $0.value, kind: .group) }
    }
}

@available(iOS 17.0, *)
struct VaultEntityQuery: EntityQuery {
    func entities(for identifiers: [String]) async throws -> [WidgetEntityAppEntity] {
        (loadWidgetData()?.vaults ?? [])
            .filter { identifiers.contains($0.id) }
            .map { WidgetEntityAppEntity(id: $0.id, name: $0.name, value: $0.value, kind: .vault) }
    }

    func suggestedEntities() async throws -> [WidgetEntityAppEntity] {
        (loadWidgetData()?.vaults ?? [])
            .map { WidgetEntityAppEntity(id: $0.id, name: $0.name, value: $0.value, kind: .vault) }
    }
}

@available(iOS 17.0, *)
struct SelectAccountIntent: WidgetConfigurationIntent {
    static var title: LocalizedStringResource = "Select Account"
    static var description = IntentDescription("Choose an account to display.")

    @Parameter(title: "Account")
    var entity: WidgetEntityAppEntity?
}

@available(iOS 17.0, *)
struct SelectHoldingIntent: WidgetConfigurationIntent {
    static var title: LocalizedStringResource = "Select Holding"
    static var description = IntentDescription("Choose a holding to display.")

    @Parameter(title: "Holding")
    var entity: WidgetEntityAppEntity?
}

@available(iOS 17.0, *)
struct SelectGroupIntent: WidgetConfigurationIntent {
    static var title: LocalizedStringResource = "Select Group"
    static var description = IntentDescription("Choose a group to display.")

    @Parameter(title: "Group")
    var entity: WidgetEntityAppEntity?
}

@available(iOS 17.0, *)
struct SelectVaultIntent: WidgetConfigurationIntent {
    static var title: LocalizedStringResource = "Select Vault"
    static var description = IntentDescription("Choose a vault to display.")

    @Parameter(title: "Vault")
    var entity: WidgetEntityAppEntity?
}
