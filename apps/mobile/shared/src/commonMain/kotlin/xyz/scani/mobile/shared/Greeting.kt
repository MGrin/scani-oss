package xyz.scani.mobile.shared

class Greeting {
    fun greet(): String = "Scani on ${currentPlatform().name}"
}
