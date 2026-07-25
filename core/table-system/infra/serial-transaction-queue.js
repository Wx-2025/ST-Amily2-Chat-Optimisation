/**
 * Create a FIFO promise queue for read-modify-persist-publish transactions.
 * A rejected operation never poisons the tail; the next operation still runs.
 */
export function createSerialTransactionQueue() {
    let tail = Promise.resolve();

    return function enqueue(operation) {
        if (typeof operation !== 'function') {
            return Promise.reject(new TypeError('Transaction operation must be a function.'));
        }
        const pending = tail.then(operation, operation);
        tail = pending.then(() => undefined, () => undefined);
        return pending;
    };
}
