/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { strict as assert } from "assert";
import { IChannelServices } from "@fluidframework/datastore-definitions";
import {
    MockFluidDataStoreRuntime,
    MockContainerRuntimeFactory,
    MockContainerRuntimeFactoryForReconnection,
    MockContainerRuntimeForReconnection,
    MockStorage,
} from "@fluidframework/test-runtime-utils";
import { SharedString } from "../sharedString";
import { SharedStringFactory } from "../sequenceFactory";
import { IntervalCollection, IntervalType, SequenceInterval } from "../intervalCollection";

const assertIntervals = (
    sharedString: SharedString,
    intervalCollection: IntervalCollection<SequenceInterval>,
    expected: readonly { start: number; end: number; }[],
) => {
    const actual = intervalCollection.findOverlappingIntervals(0, sharedString.getLength() - 1);
    assert.strictEqual(actual.length, expected.length,
        `findOverlappingIntervals() must return the expected number of intervals`);

    for (const actualInterval of actual) {
        const start = sharedString.localRefToPos(actualInterval.start);
        const end = sharedString.localRefToPos(actualInterval.end);
        let found = false;

        // console.log(`[${start},${end}): ${sharedString.getText().slice(start, end)}`);

        for (const expectedInterval of expected) {
            if (expectedInterval.start === start && expectedInterval.end === end) {
                found = true;
                break;
            }
        }

        assert(found, `Unexpected interval [${start}..${end}) (expected ${JSON.stringify(expected)})`);
    }
};

describe("SharedString interval collections", () => {
    let sharedString: SharedString;
    let dataStoreRuntime1: MockFluidDataStoreRuntime;

    beforeEach(() => {
        dataStoreRuntime1 = new MockFluidDataStoreRuntime();
        sharedString = new SharedString(dataStoreRuntime1, "shared-string-1", SharedStringFactory.Attributes);
    });

    describe("in a connected state with a remote SharedString", () => {
        let sharedString2: SharedString;
        let containerRuntimeFactory: MockContainerRuntimeFactory;

        beforeEach(() => {
            containerRuntimeFactory = new MockContainerRuntimeFactory();

            // Connect the first SharedString.
            dataStoreRuntime1.local = false;
            const containerRuntime1 = containerRuntimeFactory.createContainerRuntime(dataStoreRuntime1);
            const services1 = {
                deltaConnection: containerRuntime1.createDeltaConnection(),
                objectStorage: new MockStorage(),
            };
            sharedString.initializeLocal();
            sharedString.connect(services1);

            // Create and connect a second SharedString.
            const dataStoreRuntime2 = new MockFluidDataStoreRuntime();
            const containerRuntime2 = containerRuntimeFactory.createContainerRuntime(dataStoreRuntime2);
            const services2 = {
                deltaConnection: containerRuntime2.createDeltaConnection(),
                objectStorage: new MockStorage(),
            };

            sharedString2 = new SharedString(dataStoreRuntime2, "shared-string-2", SharedStringFactory.Attributes);
            sharedString2.initializeLocal();
            sharedString2.connect(services2);
        });

        it("can maintain interval consistency", () => {
            const collection1 = sharedString.getIntervalCollection("test");
            sharedString.insertText(0, "xyz");
            containerRuntimeFactory.processAllMessages();
            const collection2 = sharedString2.getIntervalCollection("test");
            assert.notStrictEqual(collection2, undefined, "undefined");
            assert.strictEqual(sharedString.getText(), sharedString2.getText(), "not equal text");

            sharedString.insertText(0, "abc");
            const interval = collection1.add(1, 1, IntervalType.SlideOnRemove);
            const intervalId = interval.getIntervalId();
            sharedString2.insertText(0, "wha");

            containerRuntimeFactory.processAllMessages();
            assert.strictEqual(sharedString.getText(), "whaabcxyz", "different text 1");
            assert.strictEqual(sharedString.getText(), "whaabcxyz", "different text 2");

            assertIntervals(sharedString, collection1, [
                { start: 4, end: 4 },
            ]);
            assertIntervals(sharedString2, collection2, [
                { start: 4, end: 4 },
            ]);

            collection2.change(intervalId, 1, 6);
            sharedString.removeText(0, 2);
            collection1.change(intervalId, 0, 5);

            containerRuntimeFactory.processAllMessages();

            assertIntervals(sharedString, collection1, [
                { start: 0, end: 5 },
            ]);
            assertIntervals(sharedString2, collection2, [
                { start: 0, end: 5 },
            ]);

            collection1.change(intervalId, sharedString.getLength() - 1, sharedString.getLength() - 1);

            containerRuntimeFactory.processAllMessages();

            assertIntervals(sharedString, collection1, [
                { start: sharedString.getLength() - 1, end: sharedString.getLength() - 1 },
            ]);
            assertIntervals(sharedString2, collection2, [
                { start: sharedString2.getLength() - 1, end: sharedString2.getLength() - 1 },
            ]);
        });

        it("can slide intervals on create conflict with remove range", () => {
            const collection1 = sharedString.getIntervalCollection("test");
            sharedString.insertText(0, "ABCD");
            containerRuntimeFactory.processAllMessages();
            const collection2 = sharedString2.getIntervalCollection("test");

            sharedString.removeRange(1, 3);

            collection2.add(1, 3, IntervalType.SlideOnRemove);

            containerRuntimeFactory.processAllMessages();

            assertIntervals(sharedString2, collection2, [
                { start: 1, end: 1 },
            ]);
            assertIntervals(sharedString, collection1, [
                { start: 1, end: 1 },
            ]);
        });

        it("can maintain consistency of LocalReference's when segments are packed", async () => {
            // sharedString.insertMarker(0, ReferenceType.Tile, { nodeType: "Paragraph" });

            const collection1 = sharedString.getIntervalCollection("test2");
            containerRuntimeFactory.processAllMessages();
            const collection2 = sharedString2.getIntervalCollection("test2");

            sharedString.insertText(0, "a");
            sharedString.insertText(1, "b");
            sharedString.insertText(2, "c");
            sharedString.insertText(3, "d");
            sharedString.insertText(4, "e");
            sharedString.insertText(5, "f");

            containerRuntimeFactory.processAllMessages();

            assert.strictEqual(sharedString.getText(), "abcdef", "incorrect text 1");
            assert.strictEqual(sharedString2.getText(), "abcdef", "incorrect text 2");

            collection1.add(2, 2, IntervalType.SlideOnRemove);

            containerRuntimeFactory.processAllMessages();

            assertIntervals(sharedString, collection1, [
                { start: 2, end: 2 },
            ]);
            assertIntervals(sharedString2, collection2, [
                { start: 2, end: 2 },
            ]);

            sharedString.insertText(0, "a");
            sharedString.insertText(1, "b");
            sharedString.insertText(2, "c");
            sharedString.insertText(3, "d");
            sharedString.insertText(4, "e");
            sharedString.insertText(5, "f");

            containerRuntimeFactory.processAllMessages();

            assert.strictEqual(sharedString.getText(), "abcdefabcdef", "incorrect text 2");
            assert.strictEqual(sharedString2.getText(), "abcdefabcdef", "incorrect text 3");

            collection1.add(5, 5, IntervalType.SlideOnRemove);
            collection1.add(2, 2, IntervalType.SlideOnRemove);

            containerRuntimeFactory.processAllMessages();

            assertIntervals(sharedString, collection1, [
                { start: 2, end: 2 },
                { start: 5, end: 5 },
                { start: 8, end: 8 },
            ]);
            assertIntervals(sharedString2, collection2, [
                { start: 2, end: 2 },
                { start: 5, end: 5 },
                { start: 8, end: 8 },
            ]);

            // Summarize to cause Zamboni to pack segments. Confirm consistency after packing.
            await sharedString2.summarize();

            assertIntervals(sharedString, collection1, [
                { start: 2, end: 2 },
                { start: 5, end: 5 },
                { start: 8, end: 8 },
            ]);
            assertIntervals(sharedString2, collection2, [
                { start: 2, end: 2 },
                { start: 5, end: 5 },
                { start: 8, end: 8 },
            ]);
        });

        it("test IntervalCollection creation events", () => {
            let createCalls1 = 0;
            const createInfo1 = [];
            const createCallback1 = (label: string, local: boolean, target: SharedString) => {
                assert.strictEqual(target, sharedString, "Expected event to target sharedString");
                createInfo1[createCalls1++] = { local, label };
            };
            sharedString.on("createIntervalCollection", createCallback1);

            let createCalls2 = 0;
            const createInfo2 = [];
            const createCallback2 = (label: string, local: boolean, target: SharedString) => {
                assert.strictEqual(target, sharedString2, "Expected event to target sharedString2");
                createInfo2[createCalls2++] = { local, label };
            };
            sharedString2.on("createIntervalCollection", createCallback2);

            const collection1: IntervalCollection<SequenceInterval> = sharedString.getIntervalCollection("test1");
            const interval1 = collection1.add(0, 1, IntervalType.SlideOnRemove);
            collection1.change(interval1.getIntervalId(), 1, 4);

            const collection2: IntervalCollection<SequenceInterval> = sharedString2.getIntervalCollection("test2");
            const interval2 = collection2.add(0, 2, IntervalType.SlideOnRemove);
            collection2.removeIntervalById(interval2.getIntervalId());

            const collection3: IntervalCollection<SequenceInterval> = sharedString2.getIntervalCollection("test3");
            collection3.add(0, 3, IntervalType.SlideOnRemove);

            containerRuntimeFactory.processAllMessages();

            const verifyCreateEvents = (s: SharedString, createInfo, infoArray) => {
                let i = 0;
                const labels = s.getIntervalCollectionLabels();
                for (const label of labels) {
                    assert.equal(label, infoArray[i].label, `Bad label ${i}: ${label}`);
                    assert.equal(label, createInfo[i].label, `Bad label ${i}: ${createInfo[i].label}`);
                    assert.equal(
                        createInfo[i].local, infoArray[i].local, `Bad local value ${i}: ${createInfo[i].local}`);
                    i++;
                }
                assert.equal(infoArray.length, createInfo.length, `Wrong number of create calls: ${i}`);
            };
            verifyCreateEvents(sharedString, createInfo1, [
                { label: "intervalCollections/test1", local: true },
                { label: "intervalCollections/test2", local: false },
                { label: "intervalCollections/test3", local: false },
            ]);
            verifyCreateEvents(sharedString2, createInfo2, [
                { label: "intervalCollections/test2", local: true },
                { label: "intervalCollections/test3", local: true },
                { label: "intervalCollections/test1", local: false },
            ]);
        });
    });

    // TODO: Enable this test suite once correctness issues with reconnect are addressed.
    // See https://github.com/microsoft/FluidFramework/issues/8739 for more context.
    describe.skip("reconnect", () => {
        let containerRuntimeFactory: MockContainerRuntimeFactoryForReconnection;
        let containerRuntime1: MockContainerRuntimeForReconnection;
        let containerRuntime2: MockContainerRuntimeForReconnection;
        let sharedString2: SharedString;

        let collection1: IntervalCollection<SequenceInterval>;
        let collection2: IntervalCollection<SequenceInterval>;
        let interval: SequenceInterval;

        beforeEach(async () => {
            containerRuntimeFactory = new MockContainerRuntimeFactoryForReconnection();

            // Connect the first SharedString.
            containerRuntime1 = containerRuntimeFactory.createContainerRuntime(dataStoreRuntime1);
            const services1: IChannelServices = {
                deltaConnection: containerRuntime1.createDeltaConnection(),
                objectStorage: new MockStorage(),
            };
            sharedString.initializeLocal();
            sharedString.connect(services1);

            // Create and connect a second SharedString.
            const runtime2 = new MockFluidDataStoreRuntime();
            containerRuntime2 = containerRuntimeFactory.createContainerRuntime(runtime2);
            sharedString2 = new SharedString(runtime2, "shared-string-2", SharedStringFactory.Attributes);
            const services2: IChannelServices = {
                deltaConnection: containerRuntime2.createDeltaConnection(),
                objectStorage: new MockStorage(),
            };
            sharedString2.initializeLocal();
            sharedString2.connect(services2);

            sharedString.insertText(0, "hello friend");
            collection1 = sharedString.getIntervalCollection("test");
            containerRuntimeFactory.processAllMessages();

            collection2 = sharedString2.getIntervalCollection("test");
            containerRuntimeFactory.processAllMessages();

            // Note: at the start of each test, this interval is only visible to client 1.
            interval = collection1.add(6, 8, IntervalType.SlideOnRemove); // the "fr" in "friend"
        });

        it("addInterval resubmitted with concurrent insert", async () => {
            containerRuntime1.connected = false;

            sharedString2.insertText(7, "amily its my f");
            containerRuntimeFactory.processAllMessages();

            containerRuntime1.connected = true;
            containerRuntimeFactory.processAllMessages();

            assert.equal(sharedString2.getText(), "hello family its my friend");
            assertIntervals(sharedString2, collection2, [
                { start: 6, end: 22 },
            ]);
            assertIntervals(sharedString, collection1, [
                { start: 6, end: 22 },
            ]);
        });

        it("addInterval resubmitted with concurrent delete", async () => {
            containerRuntime1.connected = false;

            sharedString2.removeText(5, 9);
            containerRuntimeFactory.processAllMessages();

            containerRuntime1.connected = true;
            containerRuntimeFactory.processAllMessages();

            assert.equal(sharedString2.getText(), "helloend");
            assertIntervals(sharedString2, collection2, [
                { start: 5, end: 5 },
            ]);
            assertIntervals(sharedString, collection1, [
                { start: 5, end: 5 },
            ]);
        });

        it("delete resubmitted with concurrent insert", async () => {
            containerRuntimeFactory.processAllMessages();
            containerRuntime1.connected = false;

            collection1.removeIntervalById(interval.getIntervalId());
            sharedString2.insertText(7, "amily its my f");
            containerRuntimeFactory.processAllMessages();

            containerRuntime1.connected = true;
            containerRuntimeFactory.processAllMessages();

            // Verify that the changes were correctly received by the second SharedString
            assert.equal(sharedString2.getText(), "hello family its my friend");
            assertIntervals(sharedString2, collection2, []);
            assertIntervals(sharedString, collection1, []);
        });

        it("change resubmitted with concurrent insert", async () => {
            containerRuntimeFactory.processAllMessages();
            containerRuntime1.connected = false;

            collection1.change(interval.getIntervalId(), 5, 9); // " fri"
            sharedString2.insertText(7, "amily its my f");
            containerRuntimeFactory.processAllMessages();

            containerRuntime1.connected = true;
            containerRuntimeFactory.processAllMessages();

            assert.equal(sharedString2.getText(), "hello family its my friend");
            assertIntervals(sharedString2, collection2, [
                { start: 5, end: 23 },
            ]);
            assertIntervals(sharedString, collection1, [
                { start: 5, end: 23 },
            ]);
        });

        it("change resubmitted with concurrent delete", async () => {
            containerRuntimeFactory.processAllMessages();
            containerRuntime1.connected = false;

            collection1.change(interval.getIntervalId(), 5, 9); // " fri"
            sharedString2.removeText(8, 10);
            containerRuntimeFactory.processAllMessages();

            containerRuntime1.connected = true;
            containerRuntimeFactory.processAllMessages();

            assert.equal(sharedString2.getText(), "hello frnd");
            assertIntervals(sharedString2, collection2, [
                { start: 5, end: 8 },
            ]);
            assertIntervals(sharedString, collection1, [
                { start: 5, end: 8 },
            ]);
        });
    });
});