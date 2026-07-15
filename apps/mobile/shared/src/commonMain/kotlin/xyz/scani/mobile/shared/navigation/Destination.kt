package xyz.scani.mobile.shared.navigation

sealed interface Destination {
    data object Dashboard : Destination
    data class Holding(val id: String) : Destination
    data class Account(val id: String) : Destination
    data class Institution(val id: String) : Destination
    data class Vault(val id: String) : Destination
    data class Group(val id: String) : Destination
    data class Job(val id: String) : Destination
    data object AuthCallback : Destination
}
