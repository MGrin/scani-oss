package xyz.scani.mobile.shared.auth

import io.ktor.client.HttpClient
import io.ktor.client.engine.HttpClientEngine
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.http.ContentType
import io.ktor.http.contentType
import io.ktor.http.isSuccess
import io.ktor.serialization.kotlinx.json.json
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonObjectBuilder
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

class AuthException(message: String) : RuntimeException(message)

// Thin Ktor client over Better-Auth's email-OTP REST endpoints. The `bearer`
// plugin returns the session token in the `set-auth-token` response header.
class AuthApi(engine: HttpClientEngine, private val baseUrl: String) {
    private val http = HttpClient(engine) {
        install(ContentNegotiation) { json(Json { ignoreUnknownKeys = true }) }
        expectSuccess = false
    }

    suspend fun sendSignInOtp(email: String) {
        val res = http.post("$baseUrl/api/auth/email-otp/send-verification-otp") {
            contentType(ContentType.Application.Json)
            setBody(jsonBody { put("email", email); put("type", "sign-in") })
        }
        if (!res.status.isSuccess()) throw AuthException("send OTP failed: ${res.status}")
    }

    // Better-Auth's bearer plugin returns the session token in the `set-auth-token`
    // response header (not Set-Cookie) so mobile clients persist it without cookies.
    suspend fun verifySignInOtp(email: String, otp: String): String {
        val res: HttpResponse = http.post("$baseUrl/api/auth/sign-in/email-otp") {
            contentType(ContentType.Application.Json)
            setBody(jsonBody { put("email", email); put("otp", otp) })
        }
        if (!res.status.isSuccess()) throw AuthException("verify OTP failed: ${res.status}")
        return res.headers["set-auth-token"] ?: throw AuthException("no set-auth-token header in sign-in response")
    }

    private fun jsonBody(build: JsonObjectBuilder.() -> Unit): JsonObject = buildJsonObject(build)
}
