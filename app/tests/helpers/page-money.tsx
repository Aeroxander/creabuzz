/**
 * What the money screens' tests render for "the project's money as the page draws it": what you hold and the Back box (drawn once in the top
 * of a project's page, `HoldingTop` and `BackSection`) and the Money tab (`ProjectMoney`) side by side, with the same props
 * the tab takes.
 */
import type { ComponentProps } from "react";
import { HoldingTop } from "../../src/features/pot/HoldingTop";
import { targetOf } from "../../src/features/pot/target";
import { BackSection } from "../../src/features/project/BackSection";
import { ProjectMoney } from "../../src/features/pot/ProjectMoney";

export function PageMoney(props: ComponentProps<typeof ProjectMoney>) {
  const { numbers } = props;
  return (
    <>
      {numbers && !numbers.removed ? (
        <HoldingTop
          onOpenMoney={() => {}}
          projectName={props.projectName}
          target={targetOf(numbers)}
          tasks={typeof numbers.tasks === "object" ? numbers.tasks : null}
        />
      ) : null}
      {numbers && !numbers.removed ? (
        <BackSection
          now={props.now}
          numbers={numbers}
          projectName={props.projectName}
        />
      ) : null}
      <ProjectMoney {...props} />
    </>
  );
}
