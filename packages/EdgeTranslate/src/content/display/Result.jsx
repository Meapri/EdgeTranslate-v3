/** @jsx h */
import { h, Fragment } from "preact";
import { useEffect, useRef, useReducer, useState } from "preact/hooks";
import styled, { ThemeProvider } from "styled-components";
import Channel from "common/scripts/channel.js";
import { DEFAULT_SETTINGS, getOrSetDefaultSettings } from "common/scripts/settings.js";
import { checkTimestamp } from "./utils.js";
import Notifier from "./library/notifier/notifier.js";
import DOMPurify from "dompurify";
import DrawerBlock from "./DrawerBlock.jsx";
import EditIcon from "./icons/edit.svg";
import EditDoneIcon from "./icons/edit-done.svg";
import PronounceIcon from "./icons/pronounce.svg";
import PronounceLoadingIcon from "./icons/loading.jsx";
import CopyIcon from "./icons/copy.svg";

// TTS speeds and consecutive click tracking
let sourceTTSSpeed = "fast",
    targetTTSSpeed = "fast";
let lastClickedButton = null; // "source" or "target"
let lastClickTime = 0;
// Communication channel.
const channel = new Channel();
const notifier = new Notifier("center");

function normalizeStreamPreviewText(value) {
    return String(value || "")
        .replace(/\s+/g, " ")
        .trim();
}

function getStreamPreviewSuffix(mainMeaning, streamPreviewText) {
    const stable = String(mainMeaning || "").trim();
    const preview = String(streamPreviewText || "").trim();
    if (!preview) return "";
    if (!stable) return preview;

    const stableComparable = normalizeStreamPreviewText(stable);
    const previewComparable = normalizeStreamPreviewText(preview);
    if (!previewComparable || previewComparable === stableComparable) return "";
    if (preview.startsWith(stable)) return preview.slice(stable.length).replace(/^[ \t\f\v]+/, "");
    if (!previewComparable.startsWith(stableComparable)) return preview;

    let comparable = "";
    let lastWasSpace = false;
    for (let index = 0; index < preview.length; index += 1) {
        const char = preview[index];
        if (/\s/.test(char)) {
            if (!lastWasSpace && comparable) comparable += " ";
            lastWasSpace = true;
        } else {
            comparable += char;
            lastWasSpace = false;
        }

        if (comparable.trim() === stableComparable) {
            return preview.slice(index + 1).replace(/^[ \t\f\v]+/, "");
        }
    }
    return "";
}

/**
 * @param {{
 *   mainMeaning: string;
 *   originalText: string;
 *   detailedMeanings?: Array<{
 *     pos: string;
 *     meaning: string;
 *     synonyms?: Array<string>;
 *   }>;
 *   definitions?: Array<{
 *     pos: string;
 *     meaning: string;
 *     synonyms?: Array<string>;
 *     example?: string;
 *   }>;
 *   examples?: Array<{
 *     source?: string;
 *     target?: string;
 *   }>;
 * }} props translate result
 *
 * @returns {h.JSX.Element} element
 */
export default function Result(props) {
    /**
     * The order state of displaying contents.
     */
    const [contentDisplayOrder, setContentDisplayOrder] = useState([]);

    /**
     * The visible state of contents.
     */
    const [displayTPronunciationIcon, setDisplayTPronunciationIcon] = useState(false);
    const [displaySPronunciationIcon, setDisplaySPronunciationIcon] = useState(false);
    const [contentFilter, setContentFilter] = useState({});

    /**
     * Text direction state.
     */
    const [textDirection, setTextDirection] = useState("ltr");

    /**
     * Whether to fold too long translation content.
     */
    const [foldLongContent, setFoldLongContent] = useState(true);

    /**
     * The pronounce status
     */
    const [sourcePronouncing, setSourcePronounce] = useReducer(sourcePronounce, false),
        [targetPronouncing, setTargetPronounce] = useReducer(targetPronounce, false);

    /**
     * TTS stopping state to prevent multiple stop requests
     */
    const [stopping, setStopping] = useState(false);

    // Indicate whether user can edit and copy the translation result
    const [copyResult, setCopyResult] = useReducer(copyContent, false);
    const translateResultElRef = useRef();

    // Indicate whether user is editing the original text
    const [editing, setEditing] = useReducer(_setEditing, false);
    const originalTextElRef = useRef();
    const mainMeaning = props.mainMeaning || "";
    const streamPreviewText =
        props.isStreaming && props.streamPreviewText
            ? getStreamPreviewSuffix(mainMeaning, props.streamPreviewText)
            : "";

    const TargetContent = (
        <Fragment key={"mainMeaning"}>
            {(mainMeaning.length > 0 || streamPreviewText.length > 0) && (
                <Target $isStreaming={props.isStreaming}>
                    <TextLine>
                        <div
                            dir={textDirection}
                            contenteditable={copyResult}
                            onBlur={() => setCopyResult({ copy: false })}
                            ref={translateResultElRef}
                            style={{ paddingLeft: 3 }}
                        >
                            {mainMeaning}
                            {streamPreviewText && (
                                <StreamPreview aria-hidden="true">
                                    {streamPreviewText}
                                </StreamPreview>
                            )}
                        </div>
                        <StyledCopyIcon
                            role="button"
                            onClick={() =>
                                setCopyResult({
                                    copy: true,
                                    element: translateResultElRef.current,
                                })
                            }
                            title={chrome.i18n.getMessage("CopyResult")}
                        />
                    </TextLine>
                    {displayTPronunciationIcon && (
                        <PronounceLine>
                            {targetPronouncing ? (
                                <StyledPronounceLoadingIcon
                                    role="button"
                                    onClick={(e) => {
                                        e.preventDefault();
                                        e.stopPropagation();
                                        if (stopping) return;

                                        console.log("Target TTS stop clicked");
                                        setStopping(true);
                                        // frame_closed 이벤트 직접 발송 (번역창 닫을 때와 동일한 방식)
                                        const emitPromise = channel.emit("frame_closed");
                                        if (
                                            emitPromise &&
                                            typeof emitPromise.catch === "function"
                                        ) {
                                            emitPromise
                                                .catch(() => {
                                                    // 실패 시 조용히 처리
                                                })
                                                .finally(() => {
                                                    setStopping(false);
                                                });
                                        } else {
                                            // If emit doesn't return a promise, just call finally callback
                                            setStopping(false);
                                        }
                                    }}
                                    title={chrome.i18n.getMessage("StopPronounce")}
                                />
                            ) : (
                                <StyledPronounceIcon
                                    role="button"
                                    onClick={() => setTargetPronounce(true)}
                                />
                            )}
                        </PronounceLine>
                    )}
                </Target>
            )}
        </Fragment>
    );

    const SourceContent = (
        <Fragment key={"originalText"}>
            {props.originalText?.length > 0 && (
                <Source>
                    <TextLine>
                        <div
                            dir={textDirection}
                            contenteditable={editing}
                            ref={originalTextElRef}
                            style={{ paddingLeft: 3 }}
                        >
                            {props.originalText}
                        </div>
                        {editing ? (
                            <StyledEditDoneIcon
                                role="button"
                                title={chrome.i18n.getMessage("Retranslate")}
                                onClick={() =>
                                    setEditing({
                                        edit: false,
                                        element: originalTextElRef.current,
                                    })
                                }
                            />
                        ) : (
                            <StyledEditIcon
                                role="button"
                                title={chrome.i18n.getMessage("EditText")}
                                onClick={() =>
                                    setEditing({
                                        edit: true,
                                        element: originalTextElRef.current,
                                    })
                                }
                            />
                        )}
                    </TextLine>
                    {displaySPronunciationIcon && (
                        <PronounceLine>
                            {sourcePronouncing ? (
                                <StyledPronounceLoadingIcon
                                    role="button"
                                    onClick={(e) => {
                                        e.preventDefault();
                                        e.stopPropagation();
                                        if (stopping) return;

                                        console.log("Source TTS stop clicked");
                                        setStopping(true);
                                        // frame_closed 이벤트 직접 발송 (번역창 닫을 때와 동일한 방식)
                                        const emitPromise = channel.emit("frame_closed");
                                        if (
                                            emitPromise &&
                                            typeof emitPromise.catch === "function"
                                        ) {
                                            emitPromise
                                                .catch(() => {
                                                    // 실패 시 조용히 처리
                                                })
                                                .finally(() => {
                                                    setStopping(false);
                                                });
                                        } else {
                                            // If emit doesn't return a promise, just call finally callback
                                            setStopping(false);
                                        }
                                    }}
                                    title={chrome.i18n.getMessage("StopPronounce")}
                                />
                            ) : (
                                <StyledPronounceIcon
                                    role="button"
                                    onClick={() => setSourcePronounce(true)}
                                />
                            )}
                        </PronounceLine>
                    )}
                </Source>
            )}
        </Fragment>
    );

    const DetailContent = (
        <Fragment key={"detailedMeanings"}>
            {props.detailedMeanings?.length > 0 && (
                <Detail>
                    <BlockHead>
                        <DetailHeadSpot />
                        <BlockHeadTitle>
                            {chrome.i18n.getMessage("DetailedMeanings")}
                        </BlockHeadTitle>
                        <BlockSplitLine />
                    </BlockHead>
                    <BlockContent
                        DrawerHeight={BlockContentDrawerHeight}
                        DisableDrawer={!foldLongContent}
                    >
                        {props.detailedMeanings.map((detail, detailIndex) => (
                            <Fragment key={`detail-${detailIndex}`}>
                                <Position dir={textDirection}>{detail.pos}</Position>
                                <DetailMeaning dir={textDirection}>{detail.meaning}</DetailMeaning>
                                {detail.synonyms?.length > 0 && (
                                    <Fragment>
                                        <SynonymTitle dir={textDirection}>
                                            {chrome.i18n.getMessage("Synonyms")}
                                        </SynonymTitle>
                                        <SynonymLine>
                                            {detail.synonyms.map((word, synonymIndex) => (
                                                <SynonymWord
                                                    key={`detail-synonym-${synonymIndex}`}
                                                    dir={textDirection}
                                                >
                                                    {word}
                                                </SynonymWord>
                                            ))}
                                        </SynonymLine>
                                    </Fragment>
                                )}
                            </Fragment>
                        ))}
                    </BlockContent>
                </Detail>
            )}
        </Fragment>
    );

    const DefinitionContent = (
        <Fragment key={"definitions"}>
            {props.definitions?.length > 0 && (
                <Definition>
                    <BlockHead>
                        <DefinitionHeadSpot />
                        <BlockHeadTitle>{chrome.i18n.getMessage("Definitions")}</BlockHeadTitle>
                        <BlockSplitLine />
                    </BlockHead>
                    <BlockContent
                        DrawerHeight={BlockContentDrawerHeight}
                        DisableDrawer={!foldLongContent}
                    >
                        {props.definitions.map((definition, definitionIndex) => (
                            <Fragment key={`definition-${definitionIndex}`}>
                                <Position dir={textDirection}>{definition.pos}</Position>
                                <DetailMeaning dir={textDirection}>
                                    {definition.meaning}
                                </DetailMeaning>
                                {definition.example && (
                                    <DefinitionExample
                                        dir={textDirection}
                                    >{`"${definition.example}"`}</DefinitionExample>
                                )}
                                {definition.synonyms?.length > 0 && (
                                    <Fragment>
                                        <SynonymTitle dir={textDirection}>
                                            {chrome.i18n.getMessage("Synonyms")}
                                        </SynonymTitle>
                                        <SynonymLine>
                                            {definition.synonyms.map((word, synonymIndex) => (
                                                <SynonymWord
                                                    key={`definition-synonym-${synonymIndex}`}
                                                    dir={textDirection}
                                                >
                                                    {word}
                                                </SynonymWord>
                                            ))}
                                        </SynonymLine>
                                    </Fragment>
                                )}
                            </Fragment>
                        ))}
                    </BlockContent>
                </Definition>
            )}
        </Fragment>
    );

    const ExampleContent = (
        <Fragment key={"examples"}>
            {props.examples?.length > 0 && (
                <Example>
                    <BlockHead>
                        <ExampleHeadSpot />
                        <BlockHeadTitle>{chrome.i18n.getMessage("Examples")}</BlockHeadTitle>
                        <BlockSplitLine />
                    </BlockHead>
                    <BlockContent
                        DrawerHeight={BlockContentDrawerHeight}
                        DisableDrawer={!foldLongContent}
                    >
                        <ExampleList dir={textDirection}>
                            {props.examples.map((example, index) => (
                                <ExampleItem key={`example-${index}`}>
                                    {example.source && (
                                        <ExampleSource
                                            dangerouslySetInnerHTML={{
                                                __html: DOMPurify.sanitize(example.source, {
                                                    ALLOWED_TAGS: ["b"],
                                                }),
                                            }}
                                        />
                                    )}
                                    {example.target && (
                                        <ExampleTarget
                                            // eslint-disable-next-line react/no-danger
                                            dangerouslySetInnerHTML={{
                                                __html: DOMPurify.sanitize(example.target, {
                                                    ALLOWED_TAGS: ["b"],
                                                }),
                                            }}
                                        />
                                    )}
                                </ExampleItem>
                            ))}
                        </ExampleList>
                    </BlockContent>
                </Example>
            )}
        </Fragment>
    );

    /**
     * Content maps.
     */
    const CONTENTS = {
        mainMeaning: TargetContent,
        originalText: SourceContent,
        detailedMeanings: DetailContent,
        definitions: DefinitionContent,
        examples: ExampleContent,
    };

    useEffect(() => {
        sourceTTSSpeed = "fast";
        targetTTSSpeed = "fast";
        lastClickedButton = null;
        lastClickTime = 0;

        /*
         * COMMUNICATE WITH BACKGROUND MODULE
         */
        const cancelers = [];
        cancelers.push(
            channel.on("pronouncing_finished", (detail) => {
                if (checkTimestamp(detail.timestamp)) {
                    if (detail.pronouncing === "source") {
                        setSourcePronounce(false);
                    } else if (detail.pronouncing === "target") {
                        setTargetPronounce(false);
                    } else if (detail.pronouncing === "both") {
                        setSourcePronounce(false);
                        setTargetPronounce(false);
                    }
                    setStopping(false);
                }
            })
        );

        cancelers.push(
            channel.on("pronouncing_error", (detail) => {
                if (checkTimestamp(detail.timestamp)) {
                    if (detail.pronouncing === "source") setSourcePronounce(false);
                    else if (detail.pronouncing === "target") setTargetPronounce(false);
                    notifier.notify({
                        type: "error",
                        title: chrome.i18n.getMessage("AppName"),
                        detail: chrome.i18n.getMessage("PRONOUN_ERR"),
                    });
                }
            })
        );

        cancelers.push(
            channel.on("command", (detail) => {
                switch (detail.command) {
                    case "pronounce_original":
                        setSourcePronounce(true);
                        break;
                    case "pronounce_translated":
                        setTargetPronounce(true);
                        break;
                    case "copy_result":
                        if (window.translateResult.mainMeaning && translateResultElRef.current) {
                            setCopyResult({ copy: true, element: translateResultElRef.current });
                        }
                        break;
                    default:
                        break;
                }
            })
        );

        /**
         * Update displaying contents based on user's setting.
         */
        getOrSetDefaultSettings(
            ["LayoutSettings", "TranslateResultFilter", "ContentDisplayOrder"],
            DEFAULT_SETTINGS
        ).then((result) => {
            setContentDisplayOrder(result.ContentDisplayOrder);
            setDisplaySPronunciationIcon(result.TranslateResultFilter["sPronunciationIcon"]);
            setDisplayTPronunciationIcon(result.TranslateResultFilter["tPronunciationIcon"]);
            setContentFilter(result.TranslateResultFilter);
            setTextDirection(result.LayoutSettings.RTL ? "rtl" : "ltr");
            setFoldLongContent(result.LayoutSettings.FoldLongContent);
        });
        chrome.storage.onChanged.addListener((changes, area) => {
            if (area !== "sync") return;

            if (changes.ContentDisplayOrder) {
                setContentDisplayOrder(changes.ContentDisplayOrder.newValue);
            }

            if (changes.TranslateResultFilter) {
                setDisplaySPronunciationIcon(
                    changes.TranslateResultFilter.newValue["sPronunciationIcon"]
                );
                setDisplayTPronunciationIcon(
                    changes.TranslateResultFilter.newValue["tPronunciationIcon"]
                );
                setContentFilter(changes.TranslateResultFilter.newValue);
            }

            if (changes.LayoutSettings) {
                setTextDirection(changes.LayoutSettings.newValue.RTL ? "rtl" : "ltr");
                setFoldLongContent(changes.LayoutSettings.newValue.FoldLongContent);
            }
        });

        return () => {
            // remove all of event listeners before destroying the component
            cancelers.forEach((canceler) => canceler());
        };
    }, []);

    return (
        <Fragment>
            <ThemeProvider theme={(props) => ({ ...props, textDirection })}>
                {contentDisplayOrder
                    .filter((content) => contentFilter[content])
                    .map((content) => CONTENTS[content])}
            </ThemeProvider>
        </Fragment>
    );
}

/**
 * STYLE FOR THE COMPONENT START
 */

const BlockPadding = "12px";
const BlockMargin = "10px";
const LightPrimary = "#0b57d0";
const DarkPrimary = "#a8c7fa";
const DarkOnSurface = "#e8eaed";
const DarkOnSurfaceVariant = "#bdc1c6";
const DarkSurfaceContainer = "#20262d";
const DarkSurfaceContainerHigh = "#242a31";
const DarkOutline = "#3d4651";
const MotionFast = "120ms cubic-bezier(0.2, 0, 0, 1)";
const MotionStandard = "180ms cubic-bezier(0.2, 0, 0, 1)";
const Gray = "#5f6368";
const SurfaceContainer = "#f1f4f8";
const OutlineVariant = "#e1e3e1";
const BlockContentDrawerHeight = 150; // drawer height for blocks

/**
 * basic style for a block used to display content
 */
export const Block = styled.div`
    width: 100%;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    justify-content: flex-start;
    align-items: center;
    padding: ${BlockPadding};
    margin: 0 0 ${BlockMargin};
    background-color: #fff;
    --drawer-handle-surface: #fff;
    --drawer-handle-fade: rgba(255, 255, 255, 0.44);
    --drawer-handle-hover-fade: rgba(211, 227, 253, 0.72);
    border: 1px solid ${OutlineVariant};
    border-radius: 8px;
    line-height: 1.45;
    letter-spacing: 0;
    box-shadow: 0 1px 2px rgba(60, 64, 67, 0.08);
    transition: background-color ${MotionStandard}, border-color ${MotionStandard},
        box-shadow ${MotionStandard}, color ${MotionStandard};

    @media (prefers-color-scheme: dark) {
        color: ${DarkOnSurface};
        background-color: ${DarkSurfaceContainer};
        --drawer-handle-surface: ${DarkSurfaceContainer};
        --drawer-handle-fade: rgba(32, 38, 45, 0.52);
        --drawer-handle-hover-fade: rgba(31, 59, 104, 0.72);
        border-color: ${DarkOutline};
        box-shadow: 0 1px 2px rgba(0, 0, 0, 0.26);
    }
`;

const Source = styled(Block)`
    font-weight: normal;
    white-space: pre-wrap;
    color: #5f6368;
    background: ${SurfaceContainer};
    --drawer-handle-surface: ${SurfaceContainer};
    --drawer-handle-fade: rgba(241, 244, 248, 0.5);
    --drawer-handle-hover-fade: rgba(211, 227, 253, 0.7);

    @media (prefers-color-scheme: dark) {
        color: ${DarkOnSurfaceVariant};
        background: ${DarkSurfaceContainerHigh};
        --drawer-handle-surface: ${DarkSurfaceContainerHigh};
        --drawer-handle-fade: rgba(36, 42, 49, 0.56);
        --drawer-handle-hover-fade: rgba(31, 59, 104, 0.72);
    }
`;

const Target = styled(Block)`
    font-weight: normal;
    white-space: pre-wrap;
    color: #202124;
    font-size: 16px;
    background: #ffffff;
    --drawer-handle-surface: #ffffff;
    --drawer-handle-fade: rgba(255, 255, 255, 0.44);
    position: relative;
    overflow: hidden;
    border-color: ${(props) => (props.$isStreaming ? "rgba(11, 87, 208, 0.32)" : OutlineVariant)};

    @media (prefers-color-scheme: dark) {
        color: ${DarkOnSurface};
        background: ${DarkSurfaceContainer};
        --drawer-handle-surface: ${DarkSurfaceContainer};
        --drawer-handle-fade: rgba(32, 38, 45, 0.52);
        border-color: ${(props) =>
            props.$isStreaming ? "rgba(168, 199, 250, 0.38)" : DarkOutline};
    }
`;

const StreamPreview = styled.span`
    display: block;
    margin-top: 2px;
    color: ${Gray};
    opacity: 0.72;
    transition: opacity ${MotionFast};

    &::after {
        content: "";
        display: inline-block;
        width: 6px;
        height: 6px;
        margin-left: 6px;
        border-radius: 999px;
        background: ${LightPrimary};
        vertical-align: middle;
        animation: stream-preview-pulse 1s ease-in-out infinite;
    }

    @keyframes stream-preview-pulse {
        0%,
        100% {
            opacity: 0.35;
            transform: scale(0.82);
        }
        50% {
            opacity: 0.95;
            transform: scale(1);
        }
    }

    @media (prefers-color-scheme: dark) {
        color: ${DarkOnSurfaceVariant};

        &::after {
            background: ${DarkPrimary};
        }
    }
`;

const Detail = styled(Block)`
    font-weight: normal;
`;

const TextLine = styled.div`
    width: 100%;
    display: flex;
    margin: 4px 0;
    flex-direction: ${(props) => (props.theme.textDirection === "ltr" ? "row" : "row-reverse")};
    justify-content: space-between;
    align-items: center;

    > div {
        min-width: 0;
        flex: 1 1 auto;
    }
`;

const StyledEditIcon = styled(EditIcon)`
    width: 36px;
    height: 36px;
    box-sizing: border-box;
    fill: ${Gray};
    flex: 0 0 36px;
    margin-left: 4px;
    padding: 8px;
    display: block;
    overflow: visible;
    border-radius: 999px;
    transition: fill ${MotionFast}, background-color ${MotionFast};
    &:hover {
        fill: ${LightPrimary};
        background: rgba(11, 87, 208, 0.08);
    }

    @media (prefers-color-scheme: dark) {
        fill: ${DarkOnSurfaceVariant};

        &:hover {
            fill: ${DarkPrimary};
            background: rgba(168, 199, 250, 0.14);
        }
    }
`;

const StyledEditDoneIcon = styled(EditDoneIcon)`
    width: 36px;
    height: 36px;
    box-sizing: border-box;
    fill: ${Gray};
    flex: 0 0 36px;
    margin-left: 4px;
    padding: 8px;
    display: block;
    overflow: visible;
    border-radius: 999px;
    transition: fill ${MotionFast}, background-color ${MotionFast};
    &:hover {
        fill: ${LightPrimary};
        background: rgba(11, 87, 208, 0.08);
    }

    @media (prefers-color-scheme: dark) {
        fill: ${DarkOnSurfaceVariant};

        &:hover {
            fill: ${DarkPrimary};
            background: rgba(168, 199, 250, 0.14);
        }
    }
`;

const PronounceLine = styled.div`
    width: 100%;
    margin: 8px 0 0;
    display: flex;
    flex-direction: ${(props) => (props.theme.textDirection === "ltr" ? "row" : "row-reverse")};
    justify-content: flex-start;
    align-items: flex-start;
    gap: 8px;
`;

const StyledCopyIcon = styled(CopyIcon)`
    width: 36px;
    height: 36px;
    box-sizing: border-box;
    fill: ${Gray};
    flex: 0 0 36px;
    margin-left: 4px;
    padding: 8px;
    display: block;
    overflow: visible;
    border-radius: 999px;
    transition: fill ${MotionFast}, background-color ${MotionFast};
    &:hover {
        fill: ${LightPrimary};
        background: rgba(11, 87, 208, 0.08);
    }

    @media (prefers-color-scheme: dark) {
        fill: ${DarkOnSurfaceVariant};

        &:hover {
            fill: ${DarkPrimary};
            background: rgba(168, 199, 250, 0.14);
        }
    }
`;

const StyledPronounceIcon = styled(PronounceIcon)`
    width: 36px;
    height: 36px;
    box-sizing: border-box;
    padding: 8px;
    fill: ${LightPrimary};
    flex: 0 0 36px;
    display: block;
    overflow: visible;
    border-radius: 999px;
    transition: fill ${MotionFast}, background-color ${MotionFast};
    ${(props) =>
        props.theme.textDirection === "ltr"
            ? `
                margin-right: 0;
            `
            : `
                margin-left: 0;
                transform: rotate(180deg);
            `}

    &:hover {
        fill: ${LightPrimary} !important;
        background: rgba(11, 87, 208, 0.08);
    }

    @media (prefers-color-scheme: dark) {
        fill: ${DarkPrimary};

        &:hover {
            fill: ${DarkPrimary} !important;
            background: rgba(168, 199, 250, 0.14);
        }
    }
`;

const StyledPronounceLoadingIcon = styled(PronounceLoadingIcon)`
    width: 36px;
    height: 36px;
    box-sizing: border-box;
    fill: ${LightPrimary};
    padding: 6px;
    flex: 0 0 36px;
    display: block;
    overflow: visible;
    cursor: pointer;
    border-radius: 999px;
    transition: fill ${MotionFast}, background-color ${MotionFast};

    circle {
        fill: none;
        stroke: ${LightPrimary} !important;
        transition: stroke ${MotionFast};
    }

    &:hover {
        fill: ${LightPrimary} !important;
        background: rgba(11, 87, 208, 0.08);

        circle {
            stroke: ${LightPrimary} !important;
        }
    }

    @media (prefers-color-scheme: dark) {
        fill: ${DarkPrimary};

        circle {
            stroke: ${DarkPrimary} !important;
        }

        &:hover {
            fill: ${DarkPrimary} !important;
            background: rgba(168, 199, 250, 0.14);

            circle {
                stroke: ${DarkPrimary} !important;
            }
        }
    }
`;

const BlockHead = styled.div`
    width: 100%;
    display: flex;
    flex-direction: ${(props) => (props.theme.textDirection === "ltr" ? "row" : "row-reverse")};
    flex-wrap: wrap;
    justify-content: flex-start;
    align-items: center;
`;

const BlockHeadTitle = styled.span`
    color: #202124;
    font-size: 13px;
    font-weight: 500;
    ${(props) =>
        `${props.theme.textDirection === "ltr" ? "margin-left" : "margin-right"}:${BlockPadding};`}

    @media (prefers-color-scheme: dark) {
        color: ${DarkOnSurface};
    }
`;

/**
 * common style for the spot of block head
 */
const BlockHeadSpot = styled.span`
    width: 8px;
    height: 8px;
    border-radius: 999px;
`;

const BlockSplitLine = styled.div`
    width: 100%;
    height: 1px;
    margin: 6px 0;
    flex-shrink: 0;
    border: none;
    background: ${OutlineVariant};

    @media (prefers-color-scheme: dark) {
        background: ${DarkOutline};
    }
`;

const BlockContent = styled(DrawerBlock)`
    width: 100%;
    display: flex;
    flex-direction: column;
    justify-content: flex-start;
    align-items: ${(props) => (props.theme.textDirection === "ltr" ? "flex-start" : "flex-end")};
    flex-shrink: 0;
`;

const DetailHeadSpot = styled(BlockHeadSpot)`
    background-color: #146c43;
`;

const Position = styled.div`
    color: ${Gray};
    font-size: 12px;
    font-weight: 500;

    @media (prefers-color-scheme: dark) {
        color: ${DarkOnSurfaceVariant};
    }
`;

const DetailMeaning = styled.div`
    padding: 5px 0;
    ${(props) => (props.theme.textDirection === "ltr" ? "margin-left" : "margin-right")}: 10px;

    @media (prefers-color-scheme: dark) {
        color: ${DarkOnSurface};
    }
`;

const SynonymTitle = styled.div`
    color: ${Gray};
    font-size: small;
    ${(props) => (props.theme.textDirection === "ltr" ? "margin-left" : "margin-right")}: 10px;

    @media (prefers-color-scheme: dark) {
        color: ${DarkOnSurfaceVariant};
    }
`;

const SynonymLine = styled.div`
    display: flex;
    flex-wrap: wrap;
    padding: 5px 0;
    ${(props) =>
        props.theme.textDirection === "ltr"
            ? `
                margin-left: 10px;
                flex-direction: row;
            `
            : `
                margin-right: 10px;       
                flex-direction: row-reverse;
            `};
`;

const SynonymWord = styled.span`
    padding: 4px 10px;
    margin: 0 2px 3px;
    color: ${LightPrimary};
    background: #d3e3fd;
    border: 1px solid rgba(11, 87, 208, 0.16);
    border-radius: 999px;
    cursor: pointer;
    font-size: 12px;
    font-weight: 600;
    transition: background-color ${MotionFast}, border-color ${MotionFast}, color ${MotionFast};

    @media (prefers-color-scheme: dark) {
        color: #d3e3fd;
        background: #1f3b68;
        border-color: rgba(168, 199, 250, 0.24);
    }
`;

const Definition = styled(Block)``;

const DefinitionHeadSpot = styled(BlockHeadSpot)`
    background-color: #d93025;
`;

const DefinitionExample = styled(DetailMeaning)`
    color: #5f6368;

    @media (prefers-color-scheme: dark) {
        color: ${DarkOnSurfaceVariant};
    }
`;

const Example = styled(Block)``;

const ExampleHeadSpot = styled(BlockHeadSpot)`
    background-color: ${LightPrimary};
`;

const ExampleList = styled.ol`
    list-style-type: decimal;
    ${(props) => (props.theme.textDirection === "ltr" ? "padding-left" : "padding-right")}: 1.5rem;
    margin: 0;
`;

const ExampleItem = styled.li`
    padding: 5px 0;
    font-size: small;
`;

const ExampleSource = styled.div`
    font-size: medium;

    @media (prefers-color-scheme: dark) {
        color: ${DarkOnSurface};
    }
`;

const ExampleTarget = styled.div`
    padding-top: 5px;
    font-size: medium;

    @media (prefers-color-scheme: dark) {
        color: ${DarkOnSurfaceVariant};
    }
`;

/**
 * STYLE FOR THE COMPONENT END
 */

/**
 * A reducer for source pronouncing state
 * Send message to background to pronounce the translating text.
 */
function sourcePronounce(_, startPronounce) {
    if (startPronounce) {
        const currentTime = Date.now();
        const timeSinceLastClick = currentTime - lastClickTime;

        // Only toggle speed if same button clicked consecutively within 3 seconds
        if (lastClickedButton === "source" && timeSinceLastClick < 3000) {
            sourceTTSSpeed = sourceTTSSpeed === "fast" ? "slow" : "fast";
        } else {
            // Reset to fast speed for first click or after switching buttons
            sourceTTSSpeed = "fast";
        }

        lastClickedButton = "source";
        lastClickTime = currentTime;

        const requestPromise = channel.request("pronounce", {
            pronouncing: "source",
            text: window.translateResult.originalText,
            language: window.translateResult.sourceLanguage,
            speed: sourceTTSSpeed,
        });
        if (requestPromise && typeof requestPromise.catch === "function") {
            requestPromise.catch(() => {
                // TTS 실패 처리는 조용히
            });
        }
    }
    return startPronounce;
}

/**
 * A reducer for target pronouncing state
 */
function targetPronounce(_, startPronounce) {
    if (startPronounce) {
        const currentTime = Date.now();
        const timeSinceLastClick = currentTime - lastClickTime;

        // Only toggle speed if same button clicked consecutively within 3 seconds
        if (lastClickedButton === "target" && timeSinceLastClick < 3000) {
            targetTTSSpeed = targetTTSSpeed === "fast" ? "slow" : "fast";
        } else {
            // Reset to fast speed for first click or after switching buttons
            targetTTSSpeed = "fast";
        }

        lastClickedButton = "target";
        lastClickTime = currentTime;

        const requestPromise = channel.request("pronounce", {
            pronouncing: "target",
            text: window.translateResult.mainMeaning,
            language: window.translateResult.targetLanguage,
            speed: targetTTSSpeed,
        });
        if (requestPromise && typeof requestPromise.catch === "function") {
            requestPromise.catch(() => {
                // TTS 실패 처리는 조용히
            });
        }
    }
    return startPronounce;
}

/**
 * A reducer for copying state of translation result
 * @param {*} _
 * @param {
 *     copy: boolean;  // new state
 *     element: HTMLElement; // the element for displaying translation results
 * } action
 */
function copyContent(_, action) {
    if (action.copy && action.element) {
        /**
         * This line is to make sure the div element is editable before the focus action.
         * Because of the react mechanism, contenteditable={copyResult} will work after this function is executed.
         */
        action.element.setAttribute("contenteditable", "true");

        action.element.focus();

        // select all content automatically
        let range = document.createRange();
        range.selectNodeContents(action.element);
        window.getSelection().removeAllRanges();
        window.getSelection().addRange(range);

        document.execCommand("copy");
    } else if (!action.copy) window.getSelection().removeAllRanges();
    return action.copy;
}

/**
 * The following 4 functions are intended to prevent input events from being caught by other elements.
 */

/**
 * Prevent keydown event from propagation.
 *
 * @param {Event} event keydown event.
 */
function onKeyDownInTextEditor(event) {
    event.stopPropagation();
}

/**
 * Prevent keyup event from propagation.
 *
 * @param {Event} event keyup event.
 */
function onKeyUpInTextEditor(event) {
    event.stopPropagation();
}

/**
 * When the input box gets focused, prevent input events from propagation.
 *
 * @param {Event} event focus event.
 */
function onTextEditorFocused(event) {
    event.target.addEventListener("keydown", onKeyDownInTextEditor);
    event.target.addEventListener("keyup", onKeyUpInTextEditor);
}

/**
 * When the input box gets blurred, allow input events propagation.
 *
 * @param {Event} event blur event.
 */
function onTextEditorBlurred(event) {
    event.target.removeEventListener("keydown", onKeyDownInTextEditor);
    event.target.removeEventListener("keyup", onKeyUpInTextEditor);
}

/**
 * Edit original text.
 *
 * @param {HTMLElement} originalTextEle original text element
 */
function editOriginalText(originalTextEle) {
    // Prevent input events from propagation.
    originalTextEle.addEventListener("focus", onTextEditorFocused);
    originalTextEle.addEventListener("blur", onTextEditorBlurred);

    /**
     * Make the editable element automatically focus.
     * Use setTimeout because of https://stackoverflow.com/a/37162116.
     */
    setTimeout(() => originalTextEle.focus());
}

/**
 * Submit and translate edited text.
 *
 * @param {HTMLElement} originalTextEle original text element
 */
function submitEditedText(originalTextEle) {
    // Allow input events propagation.
    originalTextEle.removeEventListener("focus", onTextEditorFocused);
    originalTextEle.removeEventListener("blur", onTextEditorBlurred);

    let text = originalTextEle.textContent.trim();
    if (text.length > 0) {
        // to make sure the new text is different from the original text
        if (text.valueOf() !== window.translateResult.originalText.valueOf()) {
            // Do translating.
            channel.request("translate", { text });
        }
    } else {
        // Restore original text.
        originalTextEle.textContent = window.translateResult.originalText;
    }
}

/**
 * A reducer for updating editing state of original text.
 *
 * @param {any} _ nothing
 * @param {{edit: boolean; element: HTMLElement;}} state new state information
 * @returns new state
 */
function _setEditing(_, state) {
    if (state.element) {
        if (state.edit) {
            editOriginalText(state.element);
        } else {
            submitEditedText(state.element);
        }
    }
    return state.edit;
}
