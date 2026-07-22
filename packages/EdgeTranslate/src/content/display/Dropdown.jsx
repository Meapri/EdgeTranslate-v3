/** @jsx h */
import { h, cloneElement } from "preact";
import { forwardRef } from "preact/compat";
import { useState, useRef, useCallback, useEffect } from "preact/hooks";
import styled, { css } from "styled-components";
import ArrowDownIcon from "./icons/arrow-down.svg";
import { EDGE_UI } from "common/scripts/ui_design_tokens.js";

const MotionFast = EDGE_UI.motion.fast;

/**
 *
 * @param {{
 *   className?: string;
 *   title: string; // Menu defaults to display content.
 *   activeKey?: any; // Similar to the value property of select element.
 *   onSelect?: (eventKey: any, event: MouseEvent) => void; // Selected callback function.
 *   onOpen?: ()=>void; // Menu Pop-up callback function
 *   onClose?: ()=>void; // The callback function that the menu closes.
 *   children?: h.JSX.Element;
 * }} props
 * @returns {h.JSX.Element} element
 */
const Dropdown = forwardRef((props, ref) => {
    const { onClose } = props;
    const [open, setOpen] = useState(false);
    const titleElRef = useRef();
    const menuElRef = useRef();
    const clickAwayHandler = useCallback((event) => {
        // Chrome has the "path" property and Firefox has the "composedPath" function.
        const path = event.path || (event.composedPath && event.composedPath());
        if (!titleElRef.current.contains(path[0])) {
            setOpen(false);
            window.removeEventListener("click", clickAwayHandler);
        }
    }, []);
    const closeMenu = useCallback(() => {
        setOpen(false);
        window.removeEventListener("click", clickAwayHandler);
        onClose && onClose();
    }, [clickAwayHandler, onClose]);
    const Items = props.children?.map((child) =>
        cloneElement(child, {
            active: child.props.eventKey === props.activeKey,
            onSelect: (eventKey, event) => {
                if (eventKey !== props.activeKey) props.onSelect && props.onSelect(eventKey, event);
            },
        })
    );
    useEffect(() => {
        return () => window.removeEventListener("click", clickAwayHandler);
    }, [clickAwayHandler]);

    return (
        <StyledSelect className={props.className} ref={ref}>
            <Title
                type="button"
                ref={titleElRef}
                aria-haspopup="menu"
                aria-expanded={open}
                onClick={() => {
                    if (!open) {
                        window.addEventListener("click", clickAwayHandler);
                        props.onOpen && props.onOpen();
                    } else onClose && onClose();
                    setOpen(!open);
                }}
                onKeyDown={(event) => {
                    if (event.key === "Escape" && open) {
                        event.preventDefault();
                        closeMenu();
                    } else if (event.key === "ArrowDown" && !open) {
                        event.preventDefault();
                        window.addEventListener("click", clickAwayHandler);
                        props.onOpen && props.onOpen();
                        setOpen(true);
                        requestAnimationFrame(() => menuElRef.current?.firstElementChild?.focus());
                    }
                }}
            >
                <TitleLabel>{props.title}</TitleLabel>
                <StyledArrowDownIcon />
            </Title>
            <Menu
                ref={menuElRef}
                open={open}
                role="menu"
                aria-hidden={!open}
                onKeyDown={(event) => {
                    const items = Array.from(menuElRef.current?.children || []);
                    const index = items.indexOf(document.activeElement);
                    if (event.key === "Escape") {
                        event.preventDefault();
                        closeMenu();
                        titleElRef.current?.focus();
                    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                        event.preventDefault();
                        const delta = event.key === "ArrowDown" ? 1 : -1;
                        items[(index + delta + items.length) % items.length]?.focus();
                    } else if (event.key === "Home" || event.key === "End") {
                        event.preventDefault();
                        items[event.key === "Home" ? 0 : items.length - 1]?.focus();
                    }
                }}
            >
                {Items}
            </Menu>
        </StyledSelect>
    );
});
Dropdown.displayName = "Dropdown";

/**
 *
 * @param {{
 *   className?: string;
 *   eventKey: any; // The value of the current option.
 *   active: boolean; // Active the current option.
 *   onSelect: (eventKey: any, event: MouseEvent) => void; // Select the callback function for the current option.
 *   children?: h.JSX.Element;
 * }} props
 * @returns {h.JSX.Element} element
 */
Dropdown.Item = function DropdownItem(props) {
    return (
        <Item
            type="button"
            role="menuitemradio"
            aria-checked={Boolean(props.active)}
            className={props.className}
            active={props.active}
            onClick={(event) => {
                props.onSelect && props.onSelect(props.eventKey, event);
            }}
        >
            {props.children}
        </Item>
    );
};
export default Dropdown;

/**
 * STYLE FOR THE COMPONENT START
 */
const StyledSelect = styled.div`
    position: relative;
    display: flex;
    align-items: center;
    min-width: 0;
    font-size: 0;
`;
const Menu = styled.div`
    /* Chromium-native open/close: the open/closed visual states are declared
       here (driven by the \`open\` prop), \`display ... allow-discrete\` animates
       the none↔block toggle, and @starting-style gives the first-open from-state.
       No keyframes — the menu also gets a real close animation for free. */
    display: ${(props) => (props.open ? "block" : "none")};
    opacity: ${(props) => (props.open ? 1 : 0)};
    transform: ${(props) =>
        props.open ? "translateY(0) scale(1)" : "translateY(-8px) scale(0.97)"};
    transform-origin: top center;
    min-width: 168px;
    margin: 6px 0 0;
    list-style: none;
    font-size: 14px;
    text-align: left;
    background-color: rgba(255, 255, 255, 0.85);
    backdrop-filter: blur(16px) saturate(160%);
    -webkit-backdrop-filter: blur(16px) saturate(160%);
    border: 1px solid #e5e5ea;
    border-radius: ${EDGE_UI.radius.control};
    padding: 6px;
    position: absolute;
    left: 0;
    top: 100%;
    z-index: 6;
    float: left;
    box-shadow: 0 12px 30px rgba(60, 64, 67, 0.16), 0 3px 8px rgba(60, 64, 67, 0.12);
    transition: opacity 200ms cubic-bezier(0.2, 0.8, 0.2, 1),
        transform 240ms cubic-bezier(0.2, 0.8, 0.2, 1), display 240ms allow-discrete;

    @starting-style {
        & {
            opacity: 0;
            transform: translateY(-8px) scale(0.97);
        }
    }

    @media (prefers-reduced-motion: reduce) {
        transition-duration: 1ms;
    }

    @media (prefers-color-scheme: dark) {
        background-color: rgba(32, 38, 45, 0.9);
        border-color: #48484a;
        box-shadow: 0 16px 34px rgba(0, 0, 0, 0.42), 0 4px 12px rgba(0, 0, 0, 0.3);
    }
`;
const Title = styled.button`
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    margin-bottom: 0;
    font-weight: 600;
    text-align: center;
    cursor: pointer;
    outline: 0;
    white-space: nowrap;
    border: none;
    -webkit-user-select: none;
    -moz-user-select: none;
    -ms-user-select: none;
    user-select: none;
    padding: 0 10px 0 12px;
    min-height: 40px;
    font-size: 14px;
    line-height: 1.5;
    border-radius: ${EDGE_UI.radius.pill};
    transition: color ${MotionFast}, background-color ${MotionFast};
    color: #0066cc;
    background-color: transparent;
    overflow: hidden;
    &:hover {
        color: #0066cc;
        background: rgba(0, 102, 204, 0.08);
    }
    &:hover svg {
        fill: #0066cc;
    }
    &:focus-visible {
        outline: none;
        box-shadow: 0 0 0 3px rgba(0, 102, 204, 0.2);
    }

    @media (prefers-color-scheme: dark) {
        color: #2997ff;

        &:hover {
            color: #e3edfb;
            background: rgba(41, 151, 255, 0.14);
        }

        &:hover svg {
            fill: #e3edfb;
        }
    }
`;
const TitleLabel = styled.span`
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
`;
const StyledArrowDownIcon = styled(ArrowDownIcon)`
    flex: 0 0 auto;
    fill: #0066cc;
    width: 16px;
    height: 16px;
    margin-left: 0;

    @media (prefers-color-scheme: dark) {
        fill: #2997ff;
    }
`;

/* Style of Item */
const ActiveStyle = css`
    color: #0066cc;
    font-weight: 700;
    background-color: #e3edfb;
    &:hover {
        color: #0066cc;
        background-color: #e3edfb;
    }

    @media (prefers-color-scheme: dark) {
        color: #e3edfb;
        background-color: #173a5e;

        &:hover {
            color: #e3edfb;
            background-color: #173a5e;
        }
    }
`;
const InActiveStyle = css`
    color: #1d1d1f;
    &:hover {
        color: #0066cc;
        background-color: rgba(0, 102, 204, 0.08);
    }

    @media (prefers-color-scheme: dark) {
        color: #f5f5f7;

        &:hover {
            color: #e3edfb;
            background-color: rgba(41, 151, 255, 0.14);
        }
    }
`;
const Item = styled.button`
    display: flex;
    align-items: stretch;
    width: 100%;
    min-width: 0;
    min-height: 44px;
    padding: 8px 12px;
    border: 0;
    border-radius: ${EDGE_UI.radius.control};
    font: inherit;
    text-align: left;
    clear: both;
    font-weight: 600;
    line-height: 1.4;
    white-space: normal;
    cursor: pointer;
    -webkit-user-select: none;
    -moz-user-select: none;
    -ms-user-select: none;
    user-select: none;
    transition: color ${MotionFast}, background-color ${MotionFast},
        transform 200ms cubic-bezier(0.2, 0.8, 0.2, 1);
    transform: scale(1);
    ${(props) => (props.active ? ActiveStyle : InActiveStyle)}

    &:hover {
        transform: scale(1.01);
    }
    &:active {
        transform: scale(0.98);
    }
    &:focus-visible {
        outline: none;
        box-shadow: 0 0 0 3px rgba(0, 102, 204, 0.2);
    }
`;
/**
 * STYLE FOR THE COMPONENT END
 */
