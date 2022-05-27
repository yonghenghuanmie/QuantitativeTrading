/*
*	@author huanmie<yonghenghuanmie@gmail.com>
*	@date 2022.5.25
*/

const fs = require('fs');
const axios = require('axios');
const CryptoJS = require("crypto-js");
const { Console } = require('console');
const { Spot } = require('@binance/connector');

const apiKey = 'eUNQo4d9VZXesfiIQp5jNGjqQ2VmxZw1XI1ySln6HBBn1aAfROCU5oXdjwYjouFG';
const apiSecret = fs.readFileSync(".secret").toString().trim();

const output = fs.createWriteStream('./output.log', { flags: "a" });
const errorOutput = fs.createWriteStream('./error.log', { flags: "a" });
const logger = new Console({ stdout: output, stderr: errorOutput });

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
	const after_tail = new Date("3000-01-01T16:00:00");
	let deliver_date = [
		new Date("2022-06-24T16:00:00"),
		new Date("2022-09-30T16:00:00"),
		after_tail
	];
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
		quantity += Number(fills[i].qty) * 0.99;
	return quantity;
}

async function KeepFutureAlive(data) {
	const balance_tolerance = 0.05;
	const quote_asset = "USDT";
	const base_asset = "ETH";
	const quote_need = 500;
	const down_need = 400;
	const base_down_asset = base_asset + "DOWN";

	let future_name = GetFutureName(base_asset);
	let future_balance = await GetFutureBalance(future_name);
	if (future_balance <= balance_tolerance) {
		let future_price = await GetFuturePrice(future_name);
		logger.log("================================================================================================================================");
		logger.log(new Date().toString() + " future_price:" + future_price + " future_balance:" + future_balance);

		let locked_balance = await GetLockedBalance(data.client, base_asset);
		if (locked_balance > 0) {
			logger.log(new Date().toString() + " CANCEL all the " + base_asset + quote_asset + " orders");
			await data.client.cancelOpenOrders(base_asset + quote_asset);
		}

		let base_transfer_quantity = 0;
		let base_balance = await GetBalance(data.client, base_asset);
		if (base_balance > 0.1 * quote_need / future_price) {
			base_transfer_quantity = base_balance;
		}
		else {
			let quote_balance = await GetBalance(data.client, quote_asset);
			let down_balance = await GetBalance(data.client, base_down_asset);
			if (quote_balance > quote_need) {
				logger.log(new Date().toString() + " quote_balance:" + quote_balance);
				const response = await data.client.newOrder(base_asset + quote_asset, "BUY", "MARKET", { quoteOrderQty: quote_need });
				base_transfer_quantity = GetMarketBuyQuantity(response);
				data.purchase_price.push(response.data.fills[0].price);
				data.purchase_quantity.push(base_transfer_quantity);
				logger.log(new Date().toString() + " USE " + quote_need + " " + quote_asset + " to BUY " + base_transfer_quantity + " " + base_asset);

			} else if (down_balance > down_need) {
				logger.log(new Date().toString() + " down_balance:" + down_balance);
				let quote_quantity = GetMarketSellQuantity(await data.client.newOrder(base_down_asset + quote_asset, "SELL", "MARKET", { quantity: down_need }));
				logger.log(new Date().toString() + " USE " + down_need + " " + base_down_asset + " to SELL " + quote_quantity + " " + quote_asset);

				const response = await data.client.newOrder(base_asset + quote_asset, "BUY", "MARKET", { quoteOrderQty: quote_quantity });
				base_transfer_quantity = GetMarketBuyQuantity(response);
				data.purchase_price.push(response.data.fills[0].price);
				data.purchase_quantity.push(base_transfer_quantity);
				logger.log(new Date().toString() + " USE " + quote_quantity + " " + quote_asset + " to BUY " + base_transfer_quantity + " " + base_asset);

			} else {
				logger.log("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!GAME OVER!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
			}
		}

		if (base_transfer_quantity > 0) {
			await data.client.futuresTransfer(base_asset, base_transfer_quantity, 3);
			logger.log(new Date().toString() + " Transfer " + base_transfer_quantity + " " + base_asset + " to Future " + future_name);
			data.wait_time *= 5;
		}
	}
}

(async function main() {
	const client = new Spot(apiKey, apiSecret, { logger: logger });
	const frequency = 1000;
	let purchase_price = [];
	let purchase_quantity = [];

	while (true) {
		let data = { client: client, wait_time: frequency, purchase_price: purchase_price, purchase_quantity: purchase_quantity };
		try {
			await KeepFutureAlive(data);
		}
		catch (error) {
			logger.error(new Date().toString() + " " + error);
			continue;
		}
		await new Promise(resolve => setTimeout(resolve, data.wait_time));
	}
})();