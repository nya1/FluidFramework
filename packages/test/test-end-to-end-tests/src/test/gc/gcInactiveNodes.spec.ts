/*!
 * Copyright (c) Microsoft Corporation and contributors. All rights reserved.
 * Licensed under the MIT License.
 */

import { strict as assert } from "assert";
import { stringToBuffer, TelemetryNullLogger } from "@fluidframework/common-utils";
import { LoaderHeader } from "@fluidframework/container-definitions";
import { ContainerRuntime } from "@fluidframework/container-runtime";
import { IFluidHandle } from "@fluidframework/core-interfaces";
import { DriverHeader } from "@fluidframework/driver-definitions";
import { IContainerRuntimeBase } from "@fluidframework/runtime-definitions";
import { requestFluidObject } from "@fluidframework/runtime-utils";
import { MockLogger, TelemetryDataTag } from "@fluidframework/telemetry-utils";
import { ITestContainerConfig, ITestObjectProvider } from "@fluidframework/test-utils";
import { describeNoCompat, ITestDataObject, itExpects, TestDataObjectType } from "@fluidframework/test-version-utils";
import { waitForContainerConnection } from "./gcTestSummaryUtils";

/**
 * Validates this scenario: When a GC node (data store or attachment blob) becomes inactive, i.e, it has been
 * unreferenced for a certain amount of time, using the node results in an error telemetry.
 */
describeNoCompat("GC inactive nodes tests", (getTestObjectProvider) => {
    const inactiveTimeoutMs = 100;
    const summaryLogger = new TelemetryNullLogger();
    const revivedEvent = "fluid:telemetry:ContainerRuntime:GarbageCollector:inactiveObject_Revived";
    const changedEvent = "fluid:telemetry:ContainerRuntime:GarbageCollector:inactiveObject_Changed";
    const loadedEvent = "fluid:telemetry:ContainerRuntime:GarbageCollector:inactiveObject_Loaded";

    let provider: ITestObjectProvider;
    let mockLogger: MockLogger;

    /** Waits for the inactive timeout to expire. */
    async function waitForInactiveTimeout(): Promise<void> {
        await new Promise<void>((resolve) => {
            setTimeout(resolve, inactiveTimeoutMs + 10);
        });
    }

    /** Validates that none of the inactive events have been logged since the last run. */
    function validateNoInactiveEvents() {
        assert(
            !mockLogger.matchAnyEvent([
                { eventName: revivedEvent },
                { eventName: changedEvent },
                { eventName: loadedEvent },
            ]),
            "inactive object events should not have been logged",
        );
    }

    /**
     * Loads a summarizer client with the given version (if any) and returns its container runtime and summary
     * collection.
     */
    async function createSummarizerClient(config: ITestContainerConfig) {
        const requestHeader = {
            [LoaderHeader.cache]: false,
            [LoaderHeader.clientDetails]: {
                capabilities: { interactive: true },
                type: "summarizer",
            },
            [DriverHeader.summarizingClient]: true,
            [LoaderHeader.reconnect]: false,
        };
        const summarizerContainer = await provider.loadTestContainer(config, requestHeader);

        const defaultDataStore = await requestFluidObject<ITestDataObject>(summarizerContainer, "default");
        return defaultDataStore._context.containerRuntime as ContainerRuntime;
    }

    async function summarize(containerRuntime: ContainerRuntime) {
        await provider.ensureSynchronized();
        return containerRuntime.summarize({
            runGC: true,
            fullTree: true,
            trackState: false,
            summaryLogger,
        });
    }

    describe("Inactive timeout", () => {
        let containerRuntime: IContainerRuntimeBase;
        let summarizerRuntime: ContainerRuntime;
        let defaultDataStore: ITestDataObject;
        let summarizerDefaultDataStore: ITestDataObject;

        beforeEach(async function() {
            provider = getTestObjectProvider({ syncSummarizer: true });
            // These tests validate the end-to-end behavior of GC features by generating ops and summaries. However,
            // it does not post these summaries or download them. So, it doesn't need to run against real services.
            if (provider.driver.type !== "local") {
                this.skip();
            }

            mockLogger = new MockLogger();
            const testContainerConfig: ITestContainerConfig = {
                runtimeOptions: {
                    summaryOptions: { summaryConfigOverrides: { state: "disabled" } },
                    gcOptions: { gcAllowed: true, inactiveTimeoutMs },
                },
            };

            const container = await provider.makeTestContainer(testContainerConfig);
            defaultDataStore = await requestFluidObject<ITestDataObject>(container, "/");
            containerRuntime = defaultDataStore._context.containerRuntime;
            await waitForContainerConnection(container);

            summarizerRuntime = await createSummarizerClient(
                {
                    ...testContainerConfig,
                    loaderProps: { logger: mockLogger },
                },
            );
            summarizerDefaultDataStore = await requestFluidObject<ITestDataObject>(summarizerRuntime, "/");
        });

        itExpects("can generate events when unreferenced data store is accessed after it's inactive", [
            { eventName: changedEvent, timeout: inactiveTimeoutMs },
            { eventName: loadedEvent, timeout: inactiveTimeoutMs },
            { eventName: revivedEvent, timeout: inactiveTimeoutMs },
        ], async () => {
            const dataStore = await containerRuntime.createDataStore(TestDataObjectType);
            const dataObject = await requestFluidObject<ITestDataObject>(dataStore, "");
            const url = dataObject.handle.absolutePath;
            defaultDataStore._root.set("dataStore1", dataObject.handle);

            // Make changes to the data store - send an op and load it.
            dataObject._root.set("key", "value1");
            await provider.ensureSynchronized();
            await summarizerRuntime.resolveHandle({ url });

            // Summarize and validate that no unreferenced errors were logged.
            await summarize(summarizerRuntime);
            validateNoInactiveEvents();

            // Mark dataStore1 as unreferenced, send an op and load it.
            defaultDataStore._root.delete("dataStore1");
            dataObject._root.set("key", "value2");
            await provider.ensureSynchronized();
            await summarizerRuntime.resolveHandle({ url });

            // Summarize and validate that no unreferenced errors were logged.
            await summarize(summarizerRuntime);
            validateNoInactiveEvents();

            // Wait for inactive timeout. This will ensure that the unreferenced data store is inactive.
            await waitForInactiveTimeout();

            // Make changes to the inactive data store and validate that we get the changedEvent.
            dataObject._root.set("key", "value");
            await provider.ensureSynchronized();
            assert(
                mockLogger.matchEvents([
                    {
                        eventName: changedEvent,
                        timeout: inactiveTimeoutMs,
                        id: url,
                        pkg: { value: TestDataObjectType, tag: TelemetryDataTag.PackageData },
                    },
                ]),
                "changed event not generated as expected",
            );

            // Load the data store and validate that we get loadedEvent.
            await summarizerRuntime.resolveHandle({ url });
            assert(
                mockLogger.matchEvents([
                    {
                        eventName: loadedEvent,
                        timeout: inactiveTimeoutMs,
                        id: url,
                    },
                ]),
                "loaded event not generated as expected",
            );

            // Make a change again and validate that we don't get another changedEvent as we only log it
            // once per data store per session.
            dataObject._root.set("key2", "value2");
            await provider.ensureSynchronized();
            validateNoInactiveEvents();

            // Revive the inactive data store and validate that we get the revivedEvent event.
            defaultDataStore._root.set("dataStore1", dataObject.handle);
            await provider.ensureSynchronized();
            assert(
                mockLogger.matchEvents([
                    {
                        eventName: revivedEvent,
                        timeout: inactiveTimeoutMs,
                        id: url,
                        pkg: { value: TestDataObjectType, tag: TelemetryDataTag.PackageData },
                    },
                ]),
                "revived event not generated as expected",
            );
        });

        itExpects("can generate events when unreferenced attachment blob is accessed after it's inactive", [
            { eventName: loadedEvent, timeout: inactiveTimeoutMs },
            { eventName: revivedEvent, timeout: inactiveTimeoutMs },
        ], async () => {
            // Upload an attachment blobs and mark them referenced.
            const blobContents = "Blob contents";
            const blobHandle = await defaultDataStore._context.uploadBlob(stringToBuffer(blobContents, "utf-8"));
            defaultDataStore._root.set("blob", blobHandle);

            await provider.ensureSynchronized();

            // Get the blob handle in the summarizer client. Don't retrieve the underlying blob yet. We will do that
            // after the blob node is inactive.
            const summarizerBlobHandle = summarizerDefaultDataStore._root.get<IFluidHandle<ArrayBufferLike>>("blob");
            assert(summarizerBlobHandle !== undefined, "Blob handle not sync'd to summarizer client");

            // Summarize and validate that no unreferenced errors were logged.
            await summarize(summarizerRuntime);
            validateNoInactiveEvents();

            // Mark blob as unreferenced, summarize and validate that no unreferenced errors are logged yet.
            defaultDataStore._root.delete("blob");
            await summarize(summarizerRuntime);
            validateNoInactiveEvents();

            // Wait for inactive timeout. This will ensure that the unreferenced blob is inactive.
            await waitForInactiveTimeout();

            // Retrieve the blob in the summarizer client now and validate that we get the loadedEvent.
            await summarizerBlobHandle.get();
            assert(
                mockLogger.matchEvents([
                    {
                        eventName: loadedEvent,
                        timeout: inactiveTimeoutMs,
                        id: summarizerBlobHandle.absolutePath,
                    },
                ]),
                "updated event not generated as expected for attachment blobs",
            );

            // Add the handle back, summarize and validate that we get the revivedEvent.
            defaultDataStore._root.set("blob", blobHandle);
            await provider.ensureSynchronized();
            assert(
                mockLogger.matchEvents([
                    {
                        eventName: revivedEvent,
                        timeout: inactiveTimeoutMs,
                        id: summarizerBlobHandle.absolutePath,
                    },
                ]),
                "revived event not generated as expected for attachment blobs",
            );
        });
    });
});
