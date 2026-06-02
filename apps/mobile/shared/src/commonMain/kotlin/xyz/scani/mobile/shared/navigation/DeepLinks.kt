package xyz.scani.mobile.shared.navigation

object DeepLinks {
    // Hosts we accept links from. Anything else returns null (security: don't
    // route foreign-origin URLs).
    private val ALLOWED_HOSTS = setOf("app.scani.xyz", "scani.xyz")

    fun parse(url: String): Destination? {
        val afterScheme = url.substringAfter("://", missingDelimiterValue = "")
        if (afterScheme.isEmpty()) return null
        val authority = afterScheme.substringBefore('/')
        val host = authority.substringBefore(':').lowercase()
        if (host !in ALLOWED_HOSTS) return null

        val pathAndQuery = afterScheme.substringAfter('/', missingDelimiterValue = "")
        val path = pathAndQuery.substringBefore('?').trim('/')
        val segments = if (path.isEmpty()) emptyList() else path.split('/')

        return when {
            segments.isEmpty() -> Destination.Dashboard
            segments.size == 1 && segments[0] == "dashboard" -> Destination.Dashboard
            segments.size == 2 && segments[0] == "auth" && segments[1] == "callback" -> Destination.AuthCallback
            segments.size == 2 -> entity(segments[0], segments[1])
            else -> null
        }
    }

    private fun entity(kind: String, id: String): Destination? {
        if (id.isBlank()) return null
        return when (kind) {
            "holding" -> Destination.Holding(id)
            "account" -> Destination.Account(id)
            "institution" -> Destination.Institution(id)
            "vault" -> Destination.Vault(id)
            "group" -> Destination.Group(id)
            "job" -> Destination.Job(id)
            else -> null
        }
    }
}
