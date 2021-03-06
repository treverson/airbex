var util = require('util')

module.exports = function(name) {
    name = name || ''

    return function() {
        if (typeof console == 'undefined' || !console || !console.log) {
            return
        }

        try {
            var message = util.format.apply(util, arguments)
            console.log('[' + name + '] ' + message)
        } catch (e) {
        }
    }
}
