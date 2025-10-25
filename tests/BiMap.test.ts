import { BiMap } from "../src/BiMap";

describe("BiMap", () => {
    test("Get unknown returns undefined", () => {
        const map: BiMap<string, number> = new BiMap();
        expect(map.get("hi")).toBe(undefined);
    });
    test("Get unknown value returns undefined", () => {
        const map: BiMap<string, number> = new BiMap();
        expect(map.getByValue(3)).toBe(undefined);
    });
    test("Simple insert", () => {
        const map: BiMap<string, number> = new BiMap();
        map.set("a", 1);
        expect(map.get("a")).toBe(1);
        expect(map.getByValue(1)).toBe("a");
        expect(map.get("b'")).toBe(undefined);
    })
    test("Removal of non-existing key", () => {
        const map: BiMap<string, number> = new BiMap();
        map.set("a", 1);
        expect(map.delete("b")).toBe(false);
        expect(map.get("a")).toBe(1);
    })
    test("Removal by key", () => {
        const map: BiMap<string, number> = new BiMap();
        map.set("a", 1);
        expect(map.delete("a")).toBe(true);
        expect(map.get("a")).toBe(undefined);
        expect(map.getByValue(1)).toBe(undefined);
    })
    test("Removal by value", () => {
        const map: BiMap<string, number> = new BiMap();
        map.set("a", 1);
        expect(map.deleteByValue(1)).toBe(true);
        expect(map.get("a")).toBe(undefined);
        expect(map.getByValue(1)).toBe(undefined);
    })
    test("Override key", () => {
        const map: BiMap<string, number> = new BiMap();
        map.set("a", 1);
        map.set("a", 2);
        expect(map.get("a")).toBe(2);
        expect(map.getByValue(2)).toBe("a");
        expect(map.getByValue(1)).toBe(undefined);
    })
    test("Override value", () => {
        const map: BiMap<string, number> = new BiMap();
        map.set("a", 1);
        map.set("b", 1);
        expect(map.get("b")).toBe(1);
        expect(map.getByValue(1)).toBe("b");
        expect(map.get("a")).toBe(undefined);
    })
    test("Iterate", () => {
        const map: BiMap<string, number> = new BiMap();
        map.set("a", 1);
        map.set("b", 2);

        expect(Array.from(map.keys())).toEqual(["a", "b"]);
        expect(Array.from(map.values())).toEqual([1, 2]);
    })
    test("Clear", () => {
        const map: BiMap<string, number> = new BiMap();
        map.set("a", 1);
        map.set("b", 2);
        map.clear();
        expect(map.get("a")).toBe(undefined);
        expect(map.get("b")).toBe(undefined);
        expect(map.getByValue(1)).toBe(undefined);
        expect(map.getByValue(2)).toBe(undefined);

    })
})