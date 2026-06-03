package xyz.scani.mobile.shared

interface Platform {
    val name: String
}

expect fun currentPlatform(): Platform
