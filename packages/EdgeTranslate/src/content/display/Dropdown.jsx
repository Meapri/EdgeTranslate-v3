/** @jsx h */
import { h, cloneElement } from "preact";
import { forwardRef } from "preact/compat";
import { useState, useRef, useCallback, useEffect } from "preact/hooks";
import styled, { css } from "styled-components";
import ArrowDownIcon from "./icons/arrow-down.svg";

const iosEmphasized =
    "linear(0, 0.005, 0.018 1.5%, 0.066 3.7%, 0.171 7.5%, 0.346 13.6%, 0.547 21%, 0.722 29.4%, 0.853 38.4%, 0.937 47.7%, 0.978 56.8%, 0.997 67.4%, 1)";
const iosSpring =
    "linear(0, 0.046 4%, 0.196 9%, 0.523 19%, 0.81 28%, 1.012 37%, 1.099 45%, 1.108 53%, 1.069 64%, 1.014 76%, 0.987 86%, 1)";
const MotionFast = `180ms ${iosEmphasized}`;

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
    const [open, setOpen] = useState(false);
    const titleElRef = useRef();
    const clickAwayHandler = useCallback((event) => {
        // Chrome has the "path" property and Firefox has the "composedPath" function.
        const path = event.path || (event.composedPath && event.composedPath());
        if (!titleElRef.current.contains(path[0])) {
            setOpen(false);
            window.removeEventListener("click", clickAwayHandler);
        }
    }, []);
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
                ref={titleElRef}
                onClick={() => {
                    if (!open) {
                        window.addEventListener("click", clickAwayHandler);
                        props.onOpen && props.onOpen();
                    } else props.onClose && props.onClose();
                    setOpen(!open);
                }}
            >
                <TitleLabel>{props.title}</TitleLabel>
                <StyledArrowDownIcon />
            </Title>
            <Menu open={open}>{Items}</Menu>
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
            role="menuitem"
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
// iOS 26 Liquid Glass dropdown menu — light-dark() everywhere, no @media block.
const Menu = styled.ul`
    color-scheme: light dark;
    display: ${(props) => (props.open ? "block" : "none")};
    min-width: 180px;
    margin: 8px 0 0;
    list-style: none;
    font-size: 15px;
    letter-spacing: -0.2px;
    text-align: left;
    background-color: light-dark(rgba(255, 255, 255, 0.78), rgba(28, 28, 30, 0.78));
    backdrop-filter: blur(36px) saturate(190%);
    -webkit-backdrop-filter: blur(36px) saturate(190%);
    border: 0.5px solid light-dark(rgba(255, 255, 255, 0.7), rgba(255, 255, 255, 0.08));
    border-radius: 14px;
    padding: 6px;
    position: absolute;
    left: 0;
    top: 100%;
    z-index: 6;
    float: left;
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.35), 0 8px 28px rgba(0, 0, 0, 0.18),
        0 32px 64px -16px rgba(0, 0, 0, 0.22);
    animation: ios-dropdown-enter 320ms ${iosSpring} both;

    @keyframes ios-dropdown-enter {
        from {
            opacity: 0;
            transform: translateY(-6px) scale(0.97);
        }
        to {
            opacity: 1;
            transform: translateY(0) scale(1);
        }
    }
`;
const Title = styled.a`
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
    user-select: none;
    padding: 0 12px;
    min-height: 40px;
    font-size: 15px;
    letter-spacing: -0.2px;
    line-height: 1.5;
    border-radius: 9999px;
    transition: color ${MotionFast}, background-color ${MotionFast};
    color: light-dark(#007aff, #0a84ff);
    background-color: transparent;
    overflow: hidden;
    &:hover {
        background: light-dark(rgba(0, 122, 255, 0.1), rgba(10, 132, 255, 0.18));
    }
    &:active {
        background: light-dark(rgba(0, 122, 255, 0.16), rgba(10, 132, 255, 0.24));
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
    fill: light-dark(#007aff, #0a84ff);
    width: 14px;
    height: 14px;
    margin-left: 0;
`;

// iOS menu item — active state uses tinted fill, no scale on hover.
const ActiveStyle = css`
    color: light-dark(#007aff, #0a84ff);
    font-weight: 600;
    background-color: light-dark(rgba(0, 122, 255, 0.14), rgba(10, 132, 255, 0.22));
    &:hover {
        background-color: light-dark(rgba(0, 122, 255, 0.18), rgba(10, 132, 255, 0.28));
    }
`;
const InActiveStyle = css`
    color: light-dark(rgba(0, 0, 0, 0.88), rgba(255, 255, 255, 0.92));
    &:hover {
        background-color: light-dark(rgba(120, 120, 128, 0.12), rgba(118, 118, 128, 0.24));
    }
`;
const Item = styled.li`
    display: flex;
    align-items: stretch;
    min-width: 0;
    min-height: 44px;
    padding: 10px 14px;
    clear: both;
    font-weight: 500;
    letter-spacing: -0.2px;
    line-height: 1.35;
    white-space: normal;
    cursor: pointer;
    border-radius: 10px;
    -webkit-user-select: none;
    user-select: none;
    transition: color ${MotionFast}, background-color ${MotionFast}, transform 220ms ${iosSpring};
    transform: scale(1);
    ${(props) => (props.active ? ActiveStyle : InActiveStyle)}

    &:active {
        transform: scale(0.97);
    }
`;
/**
 * STYLE FOR THE COMPONENT END
 */
