package xyz.scani.mobile.shared.auth

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import xyz.scani.mobile.shared.network.PersistentCookiesStorage

class AuthRepository(
    private val api: AuthApi,
    private val cookies: PersistentCookiesStorage,
) {
    private val _signedIn = MutableStateFlow(cookies.hasAnyCookie())
    val signedIn: StateFlow<Boolean> = _signedIn.asStateFlow()

    suspend fun requestSignIn(email: String) = api.sendSignInOtp(email)

    suspend fun completeSignIn(email: String, otp: String) {
        api.verifySignInOtp(email, otp)
        _signedIn.value = cookies.hasAnyCookie()
    }

    fun isSignedIn(): Boolean = cookies.hasAnyCookie()

    suspend fun signOut() {
        runCatching { api.signOut() }
        cookies.clear()
        _signedIn.value = false
    }

    fun onUnauthorized() {
        cookies.clear()
        _signedIn.value = false
    }
}
