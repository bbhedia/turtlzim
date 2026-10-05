use crate::error::TResult;
use ::lib_permissions::{Role, Permission};
use crate::turtl::Turtl;
use ::jedi::{self, Value};
use crate::sync::incoming;

/// Holds information about a member of a space.
#[derive(Serialize, Deserialize, Debug, Default)]
pub struct SpaceMember {
    /// Member id
    #[serde(with = "crate::util::ser::str_i64_converter")]
    pub id: i64,
    /// Member's user_id
    pub user_id: String,
    /// The space_id this member belongs to
    pub space_id: String,
    /// The email of this member
    pub username: String,
    /// The role of this member
    pub role: Role,
    /// The permissions this member has
    #[serde(default)]
    pub permissions: Vec<Permission>,
    /// When the membership was created
    pub created: String,
    /// When the membership was last updated
    pub updated: String,
}

impl SpaceMember {
    /// Save this member to the API. Returns the member as the API saved it; applying that to
    /// whatever copy the caller keeps is the caller's job (so that nothing needs to stay locked
    /// while the request is out).
    pub async fn edit(&self, turtl: &Turtl) -> TResult<SpaceMember> {
        let member_data = jedi::to_val(self)?;
        let url = format!("/spaces/{}/members/{}", self.space_id, self.user_id);
        let saved_data: Value = turtl.api.put(url.as_str())?.json(&member_data).call().await?;
        incoming::ignore_syncs_maybe(turtl, &saved_data, "SpaceMember.edit()");
        Ok(jedi::from_val(saved_data)?)
    }

    /// Delete a member from a space (on the API)
    pub async fn delete(turtl: &Turtl, space_id: &String, user_id: &String) -> TResult<()> {
        let url = format!("/spaces/{}/members/{}", space_id, user_id);
        let ret: Value = turtl.api.delete(url.as_str())?.call().await?;
        incoming::ignore_syncs_maybe(turtl, &ret, "SpaceMember.delete()");
        Ok(())
    }
}

