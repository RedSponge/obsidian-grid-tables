
export class BiMap<K, V> {
    keyToValue: Map<K, V>
    valueToKey: Map<V, K>

    constructor() {
        this.keyToValue = new Map();
        this.valueToKey = new Map();
    }

    set(key: K, value: V): void {
        this.delete(key);
        this.deleteByValue(value);

        this.keyToValue.set(key, value);
        this.valueToKey.set(value, key);
    }

    get(key: K): V | undefined {
        return this.keyToValue.get(key);
    }

    getByValue(value: V): K | undefined {
        return this.valueToKey.get(value);
    }

    delete(key: K): boolean {
        const value = this.keyToValue.get(key);
        if (value) {
            this.valueToKey.delete(value);
            this.keyToValue.delete(key);
            return true;
        }

        return false;
    }

    deleteByValue(value: V): boolean {
        const key = this.valueToKey.get(value);
        if (key) {
            this.valueToKey.delete(value);
            this.keyToValue.delete(key);
            return true;
        }

        return false;
    }

    keys() {
        return this.keyToValue.keys();
    }

    values() {
        return this.keyToValue.values();
    }

    clear(): void {
        this.keyToValue.clear();
        this.valueToKey.clear();
    }
}