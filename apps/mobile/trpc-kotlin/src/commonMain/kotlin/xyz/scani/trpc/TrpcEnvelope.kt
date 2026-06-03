package xyz.scani.trpc

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

@Serializable
data class TrpcEnvelope<T>(
    val result: TrpcResult<T>? = null,
    val error: TrpcErrorBody? = null,
)

@Serializable
data class TrpcResult<T>(val data: T)

@Serializable
data class TrpcErrorBody(
    val message: String? = null,
    val code: Int? = null,
    val data: JsonElement? = null,
)

class TrpcException(message: String, val body: TrpcErrorBody?) : RuntimeException(message)
