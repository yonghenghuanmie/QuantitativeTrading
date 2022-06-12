/*
*	@author huanmie<yonghenghuanmie@gmail.com>
*	@date 2022.5.25
*/

const apiKey = 'eUNQo4d9VZXesfiIQp5jNGjqQ2VmxZw1XI1ySln6HBBn1aAfROCU5oXdjwYjouFG';
const apiSecret = fs.readFileSync(".secret").toString().trim();

const output = fs.createWriteStream('./output.log', { flags: "a" });
const errorOutput = fs.createWriteStream('./error.log', { flags: "a" });
const logger = new Console({ stdout: output, stderr: errorOutput });

const frequency = 1000;
const client = new Spot(apiKey, apiSecret, { logger: logger });
const loss_rate = 0.01;
// KeepFutureAlive
const balance_tolerance = 0.05;
const quote_asset = "USDT";
const base_asset = "ETH";
const quote_need = 250;
const down_need = 200;
const base_down_asset = base_asset + "DOWN";
// SellAsset
const future_count = 1000;
const future_count_usd = 10;
const start_price = 2325;
const profit_percent = 0.05;
const minimum_down_balance = 1600;

const after_tail = new Date("3000-01-01T16:00:00");
let deliver_date = [
	new Date("2022-06-24T16:00:00"),
	new Date("2022-09-30T16:00:00"),
	after_tail
];


async function GetBalance(client, asset) {
	let response = await client.account();
	for (let i = 0; i < response.data.balances.length; ++i)
		if (response.data.balances[i].asset == asset)
			return Number(response.data.balances[i].free);
	return 0;
}

async function GetLockedBalance(client, asset) {
	let response = await client.account();
	for (let i = 0; i < response.data.balances.length; ++i)
		if (response.data.balances[i].asset == asset)
			return Number(response.data.balances[i].locked);
	return 0;
}

function GenerateSignature(params) {
	return CryptoJS.HmacSHA256(params, apiSecret);
}

function GetFutureName(base_asset) {
	let future_name = base_asset + "USD_";
	let current_date;
	for (const date of deliver_date) {
		if (Date.now() < date.getTime()) {
			current_date = date;
			break;
		}
	}
	if (current_date.getTime() == after_tail.getTime())
		throw "Date out of range, please update deliver_date at GetFutureName.";
	future_name += current_date.getFullYear().toString().substring(2) + (current_date.getMonth() + 1).toString().padStart(2, "0") + current_date.getDate();
	return future_name;
}

async function GetFuturePrice(symbol) {
	const params = "symbol=" + symbol;
	let response = await axios.get("https://dapi.binance.com/dapi/v1/ticker/price?" + params + "&signature=" + GenerateSignature(params));
	if (response.status != 200) {
		throw new Date().toString() + " Failed to get future price:" + response.status + " " + response.statusText;
	}
	return response.data[0].price;
}

async function GetFutureBalance(symbol) {
	const params = "timestamp=" + new Date().getTime();
	let response = await axios.get("https://dapi.binance.com/dapi/v1/account?" + params + "&signature=" + GenerateSignature(params), { headers: { "X-MBX-APIKEY": apiKey } });
	if (response.status != 200) {
		throw new Date().toString() + " Failed to get future balance:" + response.status + " " + response.statusText;
	}

	for (let i = 0; i < response.data.assets.length; ++i)
		if (response.data.assets[i].asset == "ETH")
			return Number(response.data.assets[i].availableBalance);
}

function GetMarketSellQuantity(response) {
	let base_quantity = 0;
	let fills = response.data.fills;
	// Assume base asset is USD
	for (let i = 0; i < fills.length; ++i)
		base_quantity += Number(fills[i].price) * Number(fills[i].qty) - Number(fills[i].commission);
	return base_quantity;
}

function GetMarketBuyQuantity(response) {
	let quantity = 0;
	let fills = response.data.fills;
	for (let i = 0; i < fills.length; ++i)
		quantity += Number(fills[i].qty) * (1 - loss_rate);
	return quantity;
}

async function KeepFutureAlive(future_data, persistence_data) {
	if (future_data.future_balance <= balance_tolerance) {
		logger.log("================================================================================================================================");
		logger.log(new Date().toString() + " future_price:" + future_data.future_price + " future_balance:" + future_data.future_balance);

		let locked_balance = await GetLockedBalance(client, base_asset);
		if (locked_balance > 0) {
			logger.log(new Date().toString() + " CANCEL all the " + base_asset + quote_asset + " orders");
			await client.cancelOpenOrders(base_asset + quote_asset);
		}

		let base_transfer_quantity = 0;
		let base_balance = await GetBalance(client, base_asset);
		if (base_balance > 0.1 * quote_need / future_data.future_price) {
			base_transfer_quantity = base_balance;
		}
		else {
			let quote_balance = await GetBalance(client, quote_asset);
			let down_balance = await GetBalance(client, base_down_asset);
			let last_sold_quantity = quote_need;
			if (persistence_data.sold_quantity.length != 0)
				last_sold_quantity = persistence_data.sold_quantity[persistence_data.sold_quantity.length - 1];

			if (quote_balance > last_sold_quantity) {
				logger.log(new Date().toString() + " quote_balance:" + quote_balance);
				const response = await client.newOrder(base_asset + quote_asset, "BUY", "MARKET", { quoteOrderQty: last_sold_quantity });
				base_transfer_quantity = GetMarketBuyQuantity(response);
				persistence_data.purchase_price.push(Number(response.data.fills[0].price));
				persistence_data.purchase_quantity.push(base_transfer_quantity);
				if (persistence_data.sold_quantity.length != 0)
					persistence_data.sold_quantity.pop();
				logger.log(new Date().toString() + " USE " + last_sold_quantity + " " + quote_asset + " to BUY " + base_transfer_quantity + " " + base_asset);

			} else if (down_balance > down_need) {
				logger.log(new Date().toString() + " down_balance:" + down_balance);
				let quote_quantity = GetMarketSellQuantity(await client.newOrder(base_down_asset + quote_asset, "SELL", "MARKET", { quantity: down_need }));
				logger.log(new Date().toString() + " USE " + down_need + " " + base_down_asset + " to SELL " + quote_quantity + " " + quote_asset);

				const response = await client.newOrder(base_asset + quote_asset, "BUY", "MARKET", { quoteOrderQty: quote_quantity });
				base_transfer_quantity = GetMarketBuyQuantity(response);
				persistence_data.purchase_price.push(Number(response.data.fills[0].price));
				persistence_data.purchase_quantity.push(base_transfer_quantity);
				logger.log(new Date().toString() + " USE " + quote_quantity + " " + quote_asset + " to BUY " + base_transfer_quantity + " " + base_asset);

			} else {
				logger.log("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!GAME OVER!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
			}
		}

		if (base_transfer_quantity > 0) {
			await client.futuresTransfer(base_asset, base_transfer_quantity, 3);
			logger.log(new Date().toString() + " Transfer " + base_transfer_quantity + " " + base_asset + " to Future " + future_data.future_name);
			return true;
		}
	}
	return false;
}

function CalculateFutureProfit(future_data, persistence_data) {
	if (future_data.future_price > persistence_data.cost_price)
		return ((1 / start_price - 1 / future_data.future_price) - (1 / start_price - 1 / persistence_data.cost_price)) * future_count * future_count_usd;
	else
		return 0;
}

async function SellAsset(future_data, persistence_data) {
	let target_price;
	let sell_quantity;
	if (persistence_data.sell_price.length != 0 &&
		persistence_data.sell_price.length == persistence_data.purchase_quantity.length) {
		target_price = persistence_data.sell_price[persistence_data.sell_price.length - 1];
		sell_quantity = persistence_data.purchase_quantity[persistence_data.purchase_quantity.length - 1];
	} else if (persistence_data.purchase_quantity.length != 0) {
		target_price = persistence_data.purchase_price[persistence_data.purchase_price.length - 1] * (1 + profit_percent);
		sell_quantity = persistence_data.purchase_quantity[persistence_data.purchase_quantity.length - 1];
	} else {
		target_price = persistence_data.cost_price * (1 + profit_percent);
		sell_quantity = CalculateFutureProfit(future_data, persistence_data);
	}

	if (future_data.future_price > target_price) {
		logger.log("================================================================================================================================");
		logger.log(new Date().toString() + " future_price:" + future_data.future_price + " future_balance:" + future_data.future_balance);

		const down_balance = await GetBalance(client, base_down_asset);
		await client.futuresTransfer(base_asset, sell_quantity, 4);
		logger.log(new Date().toString() + " Transfer " + sell_quantity + " " + base_asset + " to Spot " + base_asset + quote_asset);
		const quote_quantity = GetMarketSellQuantity(await client.newOrder(base_asset + quote_asset, "SELL", "MARKET", { quantity: sell_quantity }));
		logger.log(new Date().toString() + " USE " + sell_quantity + " " + base_asset + " to SELL " + quote_quantity + " " + quote_asset);
		if (down_balance > minimum_down_balance) {
			persistence_data.sold_quantity.push(quote_quantity);
		} else {
			try {
				await client.newOrder(base_down_asset + quote_asset, "BUY", "MARKET", { quantity: down_need * (1 + loss_rate) });
				logger.log(new Date().toString() + " USE " + quote_quantity + " " + quote_asset + " to BUY " + down_need + " " + base_down_asset);
			} catch (error) {
				logger.error(new Date().toString());
				logger.error("response.status: " + error.response.status);
				logger.error("response.data: " + JSON.stringify(error.response.data));
				logger.error("Failed to fill minimum_down_balance, maybe you want to buy it manually?");
			}
		}
		if (persistence_data.sell_price.length != 0) {
			persistence_data.sell_price.pop();
			persistence_data.purchase_price.pop();
			persistence_data.purchase_quantity.pop();
		} else if (persistence_data.purchase_quantity.length != 0) {
			persistence_data.purchase_price.pop();
			persistence_data.purchase_quantity.pop();
		} else {
			persistence_data.cost_price = future_data.future_price;
		}
		return true;
	}
	return false;
}

(async function main() {
	let cost_price = 2255;
	let purchase_price = [2031, 1880, 1835];
	let purchase_quantity = [0.2461, 0.2659, 0.2723];
	// overwrite purchase_price sell rule.
	let sell_price = [2195, 2095, 1995];
	let sold_quantity = [];

	let persistence_data = {
		cost_price: cost_price,
		purchase_price: purchase_price,
		purchase_quantity: purchase_quantity,
		sell_price: sell_price,
		sold_quantity: sold_quantity
	};

	let persistence_data_json = JSON.stringify(persistence_data);
	try {
		const trade_data = fs.readFileSync("trade_data.json").toString();
		persistence_data_json = trade_data;
		persistence_data = JSON.parse(trade_data);
	} catch (error) { }
	if (persistence_data.purchase_price.length != persistence_data.purchase_quantity.length ||
		persistence_data.purchase_quantity.length < persistence_data.sell_price.length) {
		logger.error(new Date().toString() + " purchase_price.length must equal to purchase_quantity.length and their length greater than sell_price.length.");
		return;
	}

	while (true) {
		try {
			const future_name = GetFutureName(base_asset);
			const future_balance = await GetFutureBalance(future_name);
			const future_price = await GetFuturePrice(future_name);
			let future_data = { future_name: future_name, future_balance: future_balance, future_price: future_price };
			if (await KeepFutureAlive(future_data, persistence_data)) {
				persistence_data_json = JSON.stringify(persistence_data);
				fs.writeFileSync("trade_data.json", persistence_data_json);
			}
			if (await SellAsset(future_data, persistence_data)) {
				persistence_data_json = JSON.stringify(persistence_data);
				fs.writeFileSync("trade_data.json", persistence_data_json);
			}
		}
		catch (error) {
			persistence_data = JSON.parse(persistence_data_json);
			if (error.response) {
				logger.error(new Date().toString());
				logger.error("response.status: " + error.response.status);
				logger.error("response.data: " + JSON.stringify(error.response.data));
			} else {
				logger.error(new Date().toString() + " " + error);
			}
		}
		await new Promise(resolve => setTimeout(resolve, frequency));
	}
})();