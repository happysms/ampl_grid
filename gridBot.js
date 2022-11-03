let config = require('./config');
let ccxt = require('ccxt');

let getGridList = (lowerPrice, upperPrice, middlePrice, gridNum) => {
    let gridList = [];
    let halfGridNum = gridNum / 2;

    for (let i = 1; i < halfGridNum + 1; i++) {
        let gridPrice = middlePrice - i * (middlePrice - lowerPrice) / halfGridNum;
        gridPrice = parseFloat(gridPrice.toFixed(4));
        let gridSize = parseInt(((1 / gridPrice) * 100) / 10 + 1) * 10
        gridList.push([gridPrice, gridSize]);
    }

    gridList.push([middlePrice, parseInt(((1 / middlePrice) * 100) / 10 + 1) * 10]);

    for (let i = 1; i < halfGridNum + 1; i++) {
        let gridPrice = middlePrice + i * (upperPrice - middlePrice) / halfGridNum;
        gridPrice = parseFloat(gridPrice.toFixed(4));
        let gridSize = parseInt(((1 / gridPrice) * 100) / 10 + 1) * 10;
        gridList.push([gridPrice, gridSize]);
    }
    return gridList;
}


(async function () {
    let exchange = new ccxt.ftx({
        'apiKey': config.API_KEY,
        'secret': config.SECRET_KEY
    });
    let ticker = await exchange.fetchTicker(config.SYMBOL);
    let buyOrders = [];
    let sellOrders = [];

    // let initialBuyOrder = exchange.createMarketBuyOrder(config.SYMBOL, config.POSITION_SIZE * config.NUM_SELL_GRID_LINES);
    let gridList = getGridList(config.LOWER_PRICE, config.UPPER_PRICE, config.MIDDLE_PRICE, config.GRID_NUM);

    for (const [gridPrice, size] of gridList) {
        if (ticker['bid'] < gridPrice) {
            console.log(`submitting market limit sell order at ${gridPrice}`);
            let order = await exchange.createLimitSellOrder(config.SYMBOL, parseFloat(size), gridPrice);
            buyOrders.push(order['info']);
        }
        else {
            console.log(`submitting market limit buy order at ${gridPrice}`);
            let order = await exchange.createLimitBuyOrder(config.SYMBOL, parseFloat(size), gridPrice);
            sellOrders.push(order['info']);
        }
    }

    while (true) {
        let closedOrderIds = [];
        for (let buyOrder of buyOrders) {
            console.log(`checking buy order ${buyOrder['id']}`);

            try {
                var order = await exchange.fetchOrder(buyOrder['id']);
            } catch (error) {
                console.log("request failed: ", error);
            }

            let orderInfo = order['info'];

            if (orderInfo['status'] === config.CLOSED_ORDER_STATUS) {
                closedOrderIds.push(orderInfo['id']);
                console.log(`buy order executed at ${orderInfo['price']}`);
                let newSellPrice = parseFloat(orderInfo['price'] + config.GRID_SIZE);
                console.log(`creating new limit sell order at ${newSellPrice}`);
                let newSellOrder = await exchange.createLimitSellOrder(config.SYMBOL, config.POSITION_SIZE, newSellPrice);
                sellOrders.push(newSellOrder);
            }

            await new Promise(resolve => setTimeout(resolve, config.CHECK_ORDERS_FREQUENCY));
        }

        for (let sellOrder of sellOrders) {
            console.log(`checking sell order ${sellOrder['id']}`);

            try {
                var order = await exchange.fetchOrder(sellOrder['id']);
            } catch (error){
                console.log("request failed: ", error);
            }

            let orderInfo = order['info'];
            if (orderInfo['status'] === config.CLOSED_ORDER_STATUS) {
                closedOrderIds.push(orderInfo['id']);
                console.log(`sell order executed at ${orderInfo['price']}`);
                let newBuyPrice = parseFloat(orderInfo['price']) - config.GRID_SIZE;
                console.log(`creating new limit buy order at ${newBuyPrice}`);
                let newBuyOrder = await exchange.createLimitBuyOrder(config.SYMBOL, config.POSITION_SIZE, newBuyPrice);
                buyOrders.push(newBuyOrder);
            }
            await new Promise(resolve => setTimeout(resolve, config.CHECK_ORDERS_FREQUENCY));
        }

        closedOrderIds.forEach(closedOrderId => {
            buyOrders = buyOrders.filter(buyOrder => buyOrder['id'] !== closedOrderId);
            sellOrders = sellOrders.filter(sellOrder => sellOrder['id'] !== closedOrderId);
        });

        if (sellOrders.length === 0) {
            console.log("nothing left to sell, exiting");
            process.exit(1);
        }

        console.log("loop end")
    }
})();