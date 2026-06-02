package xyz.scani.mobile.shared.network

import kotlinx.serialization.Serializable

// Mirrors the system.ping response in apps/backend/api/openapi/scani-openapi.json.
// Hand-maintained (the spec<->router contract is CI-checked on the backend);
// keep in sync when the procedure's output changes.
@Serializable
data class PingResult(val status: String, val service: String)

class SystemApi(private val client: TrpcClient) {
    suspend fun ping(): PingResult = client.query("system.ping")
}
