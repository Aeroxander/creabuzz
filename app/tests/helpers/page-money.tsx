/**
 * What the money screens' tests render for "the project's money as the page draws it": the Back box (drawn once in the top of
 * a project's page, `BackSection`) and the Money tab (`ProjectMoney`) side by side, with the same props the tab takes.
 */
import type { ComponentProps } from "react";
import { BackSection } from "../../src/features/project/BackSection";
import { ProjectMoney } from "../../src/features/pot/ProjectMoney";

export function PageMoney(props: ComponentProps<typeof ProjectMoney>) {
  const { numbers } = props;
  return (
    <>
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
