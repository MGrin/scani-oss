package xyz.scani.mobile.android.auth

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import xyz.scani.mobile.shared.auth.AuthRepository

sealed interface AuthUiState {
    data object EnterEmail : AuthUiState
    data class EnterCode(val email: String) : AuthUiState
    data object Authenticated : AuthUiState
    data class Error(val message: String, val previous: AuthUiState) : AuthUiState
}

class AuthViewModel(private val repo: AuthRepository) : ViewModel() {
    private val _state = MutableStateFlow<AuthUiState>(
        if (repo.isSignedIn()) AuthUiState.Authenticated else AuthUiState.EnterEmail,
    )
    val state: StateFlow<AuthUiState> = _state.asStateFlow()

    private val _busy = MutableStateFlow(false)
    val busy: StateFlow<Boolean> = _busy.asStateFlow()

    fun sendCode(email: String) = run(AuthUiState.EnterEmail) {
        repo.requestSignIn(email)
        _state.value = AuthUiState.EnterCode(email)
    }

    fun verify(email: String, code: String) = run(AuthUiState.EnterCode(email)) {
        repo.completeSignIn(email, code)
        _state.value = AuthUiState.Authenticated
    }

    fun signOut() {
        repo.signOut()
        _state.value = AuthUiState.EnterEmail
    }

    private fun run(fallback: AuthUiState, block: suspend () -> Unit) {
        viewModelScope.launch {
            _busy.value = true
            try {
                block()
            } catch (e: Throwable) {
                _state.value = AuthUiState.Error(e.message ?: "Something went wrong", fallback)
            } finally {
                _busy.value = false
            }
        }
    }
}
