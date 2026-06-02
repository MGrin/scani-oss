package xyz.scani.mobile.shared.auth

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

class AuthRepository(
    private val api: AuthApi,
    private val storage: SecureStorage,
) {
    private val _signedIn = MutableStateFlow(storage.getString(TOKEN_KEY) != null)
    val signedIn: StateFlow<Boolean> = _signedIn.asStateFlow()

    suspend fun requestSignIn(email: String) = api.sendSignInOtp(email)

    suspend fun completeSignIn(email: String, otp: String) {
        val token = api.verifySignInOtp(email, otp)
        storage.putString(TOKEN_KEY, token)
        _signedIn.value = true
    }

    fun token(): String? = storage.getString(TOKEN_KEY)
    fun isSignedIn(): Boolean = token() != null

    fun signOut() {
        storage.remove(TOKEN_KEY)
        _signedIn.value = false
    }

    private companion object {
        const val TOKEN_KEY = "scani.auth.token"
    }
}
