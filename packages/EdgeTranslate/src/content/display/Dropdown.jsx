/** @jsx h */
import { h, cloneElement } from "preact";
import { forwardRef } from "preact/compat";
import { useState, useRef, useCallback, useEffect } from "preact/hooks";
import styled, { css } from "styled-components";
import ArrowDownIcon from "./icons/arrow-down.svg";

const MotionFast = "120ms cubic-bezier(0.2, 0, 0, 1)";
const MotionStandard = "180ms cubic-bezier(0.2, 0, 0, 1)";

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
const Menu = styled.ul`
    display: ${(props) => (props.open ? "block" : "none")};
    min-width: 168px;
    margin: 6px 0 0;
    list-style: none;
    font-size: 14px;
    text-align: left;
    background-color: #fff;
    border: 1px solid #e1e3e1;
    border-radius: 8px;
    padding: 6px;
    position: absolute;
    left: 0;
    top: 100%;
    z-index: 6;
    float: left;
    box-shadow: 0 12px 30px rgba(60, 64, 67, 0.16), 0 3px 8px rgba(60, 64, 67, 0.12);
    animation: et-dropdown-enter ${MotionStandard} both;

    @keyframes et-dropdown-enter {
        from {
            opacity: 0;
            transform: translateY(-4px);
        }

        to {
            opacity: 1;
            transform: translateY(0);
        }
    }

    @media (prefers-color-scheme: dark) {
        background-color: #20262d;
        border-color: #3d4651;
        box-shadow: 0 16px 34px rgba(0, 0, 0, 0.42), 0 4px 12px rgba(0, 0, 0, 0.3);
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
    -moz-user-select: none;
    -ms-user-select: none;
    user-select: none;
    padding: 0 10px 0 12px;
    min-height: 40px;
    font-size: 14px;
    line-height: 1.5;
    border-radius: 999px;
    transition: color ${MotionFast}, background-color ${MotionFast};
    color: #0b57d0;
    background-color: transparent;
    overflow: hidden;
    &:hover {
        color: #0b57d0;
        background: rgba(11, 87, 208, 0.08);
    }
    &:hover svg {
        fill: #0b57d0;
    }

    @media (prefers-color-scheme: dark) {
        color: #a8c7fa;

        &:hover {
            color: #d3e3fd;
            background: rgba(168, 199, 250, 0.14);
        }

        &:hover svg {
            fill: #d3e3fd;
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
    fill: #0b57d0;
    width: 16px;
    height: 16px;
    margin-left: 0;

    @media (prefers-color-scheme: dark) {
        fill: #a8c7fa;
    }
`;

/* Style of Item */
const ActiveStyle = css`
    color: #0b57d0;
    font-weight: 700;
    background-color: #d3e3fd;
    &:hover {
        color: #0b57d0;
        background-color: #d3e3fd;
    }

    @media (prefers-color-scheme: dark) {
        color: #d3e3fd;
        background-color: #1f3b68;

        &:hover {
            color: #d3e3fd;
            background-color: #1f3b68;
        }
    }
`;
const InActiveStyle = css`
    color: #202124;
    &:hover {
        color: #0b57d0;
        background-color: rgba(11, 87, 208, 0.08);
    }

    @media (prefers-color-scheme: dark) {
        color: #e8eaed;

        &:hover {
            color: #d3e3fd;
            background-color: rgba(168, 199, 250, 0.14);
        }
    }
`;
const Item = styled.li`
    display: flex;
    align-items: center;
    min-height: 40px;
    padding: 0 12px;
    clear: both;
    font-weight: 600;
    line-height: 1.4;
    white-space: nowrap;
    cursor: pointer;
    border-radius: 8px;
    -webkit-user-select: none;
    -moz-user-select: none;
    -ms-user-select: none;
    user-select: none;
    -webkit-transition: color ${MotionFast}, background-color ${MotionFast};
    transition: color ${MotionFast}, background-color ${MotionFast};
    transition: color ${MotionFast}, background-color ${MotionFast};
    transition-property: color, background-color;
    transition-duration: 120ms, 120ms;
    transition-timing-function: cubic-bezier(0.2, 0, 0, 1), cubic-bezier(0.2, 0, 0, 1);
    transition-delay: 0s, 0s;
    ${(props) => (props.active ? ActiveStyle : InActiveStyle)}
`;
/**
 * STYLE FOR THE COMPONENT END
 */
