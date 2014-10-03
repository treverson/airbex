var async = require('async')
, vouchers = require('./vouchers')
, util = require('util')
, num = require('num');

module.exports = exports = function(app) {
    app.post('/v1/send', app.security.demand.otp(app.security.demand.withdraw(2), true), exports.send)
}

exports.sendToEmail = function(app, from, to, currency, amount, allowNew, cb) {
    exports.sendToExistingUser(app, from, to, currency, amount,
        function(err) {
            if (!err) return cb()

            if (err.name == 'UserNotFound') {
                if (allowNew) {
                    exports.sendVoucher(app, from, to, currency, amount, cb)
                    return
                }
            }

            cb(err)
        }
    )
}

exports.friendlyCurrency = function(currency) {
    var currencyFull = currency
    if (currency == 'XRP') currencyFull = 'ripples (XRP)'
    else if (currency == 'BTC') currencyFull = 'Bitcoin (BTC)'
    else if (currency == 'LTC') currencyFull = 'Litecoin (LTC)'
    return currencyFull
}

exports.sendToExistingUser = function(app, from, to, currency, amount, cb) {
    app.conn.write.get().query({
        text: [
            'SELECT',
            '   user_transfer_to_email($1, $2, $3, $4) tid,',
            '   su.email from_email,',
            '   ru.user_id to_user_id',
            'FROM "user" su, "user" ru',
            'WHERE su.user_id = $1 AND ru.email_lower = $2'
        ].join('\n'),
        values: [
            from,
            to,
            currency,
            app.cache.parseCurrency(amount, currency)
        ]
    }, function(err, dr) {
        if (err) return cb(err)

        var row = dr.rows[0]

        if (!row) {
            err = new Error('User not found')
            err.name = 'UserNotFound'
            return cb(err)
        }

        app.activity(from, 'SendToUser', {
            to: to,
            amount: amount,
            currency: currency
        })

        app.activity(row.to_user_id, 'ReceiveFromUser', {
            from:  row.from_email,
            amount: amount,
            currency: currency
        })

        cb()
    })
}

exports.getSenderName = function(app, email, cb) {
    app.conn.read.get().query({
        text: [
            'SELECT first_name, last_name, email',
            'FROM "user"',
            'WHERE user_id = $1'
        ].join('\n'),
        values: [email]
    }, function(err, dr) {
        if (err) return cb(err)
        var row = dr.rows[0]
        if (!row.first_name) return cb(null, row.email)
        cb(null, util.format('%s %s (%s', row.first_name, row.last_name, row.email))
    })
}

exports.sendVoucher = function(app, from, to, currency, amount, cb)
{
    var voucherId
    , sender

    log.info("sendVoucher from %s, to %s amount: %s %s", from, to, amount, currency);
    
    async.series([
        // Create voucher
        function(next) {
            vouchers.create(app, from, currency, amount, function(err, res) {
                if (err) return next(err)
                voucherId = res
                next()
            })
        },

        // Find information about sender
        function(next) {
            exports.getSenderName(app, from, function(err, res) {
                if (err) return next(err)
                sender = res
                next()
            })
        },

        // Send email
        function(next) {
            var currencyFull = exports.friendlyCurrency(currency)

            // TODO: Cancel voucher on failure
            // TODO: Allow user to change sending language
            app.email.send(to, 'en-US', 'voucher-invite', {
                code: voucherId,
                currency: currencyFull,
                amount: amount,
                from: sender
            }, next)
        },

        // Log activity,
        function (next) {
            app.activity(from, 'SendToUser', {
                to: to,
                amount: amount,
                currency: currency
            })

            next()
        }
    ], cb)
}

exports.send = function(req, res, next) {
    if (!req.app.validate(req.body, 'v1/transfer', res)) return

    var currency = req.body.currency;
    
    if (!req.app.cache.currencies[currency]) {
        return res.send(400, {
            name: 'InvalidCurrency',
            message: 'Invalid currency'
        })
    }
    
    if (req.app.cache.currencies[currency].fiat) {
        return res.send(400, {
            name: 'CannotSendFiat',
            message: 'Cannot send FIAT to other users at this time'
        })
    }

    var withdraw_min = req.app.cache.currencies[currency].withdraw_min;
    var withdraw_max = req.app.cache.currencies[currency].withdraw_max;
    
    var amount = req.app.cache.parseCurrency(req.body.amount, currency)
    
    if (num(amount).lt(withdraw_min)) {
        return res.status(400).send({
            name: 'AmountTooSmall',
            message: 'Minimum amount is ' + req.app.cache.formatCurrency(withdraw_min, currency) + ' '  + currency
        })
    }
    
    if (num(amount).gt(withdraw_max)) {
        return res.status(400).send({
            name: 'AmountTooHigh',
            message: 'Maximum amount is ' + req.app.cache.formatCurrency(withdraw_max, currency) + ' '  + currency
        })
    }
    
    if(req.user.email === req.body.email){
        return res.status(400).send({
            name: 'SendToItself',
            message: 'Cannot send to yourself'
        })
    }
    exports.sendToEmail(req.app, req.user.id, req.body.email,
        req.body.currency, req.body.amount, req.body.allowNewUser,
        function(err) {
            if (!err) return res.status(204).end()

            if (err.name == 'UserNotFound') {
                return res.send(400, {
                    name: 'UserNotFound',
                    message: 'User not found'
                })
            }

            next(err)
        }
    )
}
