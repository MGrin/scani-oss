package xyz.scani.mobile.shared.auth

class AuthRepository(
    private val api: AuthApi,
    private val storage: SecureStorage,
) {
    suspend fun requestSignIn(email: String) = api.sendSignInOtp(email)

    suspend fun completeSignIn(email: String, otp: String) {
        val token = api.verifySignInOtp(email, otp)
        storage.putString(TOKEN_KEY, token)
    }

    fun token(): String? = storage.getString(TOKEN_KEY)
    fun isSignedIn(): Boolean = token() != null
    fun signOut() = storage.remove(TOKEN_KEY)

    private companion object {
        const val TOKEN_KEY = "scani.auth.token"
    }
}
