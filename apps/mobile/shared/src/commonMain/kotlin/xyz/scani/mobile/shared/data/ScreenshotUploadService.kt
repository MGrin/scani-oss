@file:OptIn(kotlin.uuid.ExperimentalUuidApi::class)

package xyz.scani.mobile.shared.data

import io.ktor.client.HttpClient
import io.ktor.client.request.header
import io.ktor.client.request.put
import io.ktor.client.request.setBody
import io.ktor.http.ContentType
import io.ktor.http.content.ByteArrayContent
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import xyz.scani.trpc.TrpcClient

class ScreenshotUploadService(
    private val http: HttpClient,
    private val trpc: TrpcClient,
    private val genId: () -> String = { kotlin.uuid.Uuid.random().toString() },
) {
    suspend fun upload(image: ByteArray, fileName: String, contentType: String, accountId: String?) {
        val presigned: UploadUrlResponse = trpc.mutate("storage.getUploadUrl", buildJsonObject {
            put("purpose", "screenshot")
            put("contentType", contentType)
            put("filename", fileName)
            put("sizeBytes", image.size)
        })
        http.put(presigned.uploadUrl) {
            presigned.headers.forEach { (k, v) -> header(k, v) }
            setBody(ByteArrayContent(image, ContentType.parse(contentType)))
        }
        trpc.mutate<JsonElement>("screenshots.parseScreenshots", buildJsonObject {
            putJsonArray("r2Keys") { add(presigned.key) }
            put("requestId", genId())
            if (accountId != null) put("accountId", accountId)
        })
    }
}
