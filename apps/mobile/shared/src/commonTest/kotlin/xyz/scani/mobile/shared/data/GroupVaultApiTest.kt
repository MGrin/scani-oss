package xyz.scani.mobile.shared.data

import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class GroupVaultApiTest {
    private fun engineFor(vararg pairs: Pair<String, String>) = MockEngine { request ->
        val path = request.url.encodedPath.removePrefix("/trpc/")
        val body = pairs.toMap()[path] ?: error("Unexpected path: $path")
        respond(
            content = body,
            status = HttpStatusCode.OK,
            headers = headersOf(HttpHeaders.ContentType, "application/json"),
        )
    }

    @Test
    fun groups_parses_list_including_null_description() = runTest {
        val engine = engineFor(
            "groups.getAllWithCounts" to """{"result":{"data":[
                {"id":"g1","name":"Tech","color":"#112233","description":null,"holdingsCount":0,"accountsCount":0},
                {"id":"g2","name":"Savings","color":"#FF0000","description":"My savings","holdingsCount":3,"accountsCount":1}
            ]}}""",
        )
        val api = MobileApi(mockTrpcClient(engine))
        val result = api.groups()
        assertEquals(2, result.size)
        assertEquals(MobileGroup(id = "g1", name = "Tech", color = "#112233", description = null), result[0])
        assertEquals(MobileGroup(id = "g2", name = "Savings", color = "#FF0000", description = "My savings"), result[1])
        assertNull(result[0].description)
    }

    @Test
    fun vaults_parses_list_including_null_iconName_and_description() = runTest {
        val engine = engineFor(
            "vaults.getAll" to """{"result":{"data":[
                {"id":"v1","name":"Car","targetAmount":"1000","currentAmount":"250","currencyId":"usd","color":"#112233","iconName":null,"description":null,"progress":25},
                {"id":"v2","name":"Vacation","targetAmount":"3000.00","currentAmount":"1200.00","currencyId":"EUR","color":"#FFFF00","iconName":"beach","description":"Summer trip"}
            ]}}""",
        )
        val api = MobileApi(mockTrpcClient(engine))
        val result = api.vaults()
        assertEquals(2, result.size)
        assertEquals(MobileVault(id = "v1", name = "Car", targetAmount = "1000", currentAmount = "250", currencyId = "usd", color = "#112233", iconName = null, description = null), result[0])
        assertEquals(MobileVault(id = "v2", name = "Vacation", targetAmount = "3000.00", currentAmount = "1200.00", currencyId = "EUR", color = "#FFFF00", iconName = "beach", description = "Summer trip"), result[1])
        assertNull(result[0].iconName)
        assertNull(result[0].description)
    }
}
