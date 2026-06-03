package xyz.scani.mobile.shared.auth

import io.ktor.client.HttpClient
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.http.ContentType
import io.ktor.http.content.TextContent
import io.ktor.http.isSuccess
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObjectBuilder
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

class AuthException(message: String) : RuntimeException(message)

class AuthApi(private val http: HttpClient, private val baseUrl: String) {
    suspend fun sendSignInOtp(email: String) {
        val res = post("/api/auth/email-otp/send-verification-otp") { put("email", email); put("type", "sign-in") }
        if (!res.status.isSuccess()) throw AuthException("send OTP failed: ${res.status}")
    }

    suspend fun verifySignInOtp(email: String, otp: String) {
        val res = post("/api/auth/sign-in/email-otp") { put("email", email); put("otp", otp) }
        if (!res.status.isSuccess()) throw AuthException("verify OTP failed: ${res.status}")
    }

    suspend fun signOut() {
        post("/api/auth/sign-out") {}
    }

    private suspend fun post(path: String, body: JsonObjectBuilder.() -> Unit): HttpResponse =
        http.post("$baseUrl$path") {
            setBody(TextContent(Json.encodeToString(buildJsonObject(body)), ContentType.Application.Json))
        }
}
